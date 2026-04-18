import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';
import {
  NotFoundError,
  UniqueViolationError,
  ValidationError,
} from '../common/errors/index.js';
import { OutboxService } from '../appointments/events/outbox.service.js';
import {
  cursorWhere,
  decodeCursor,
  keysetOrderBy,
  slicePage,
  takePlusOne,
} from '../common/pagination/cursor.util.js';
import {
  CustomerEvents,
  CustomerEventPayload,
} from './events/customer.events.js';
import { CreateCustomerDto } from './dto/create-customer.dto.js';
import { UpdateCustomerDto } from './dto/update-customer.dto.js';
import { FindOrCreateCustomerDto } from './dto/find-or-create-customer.dto.js';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto.js';
import { toE164 } from './utils/phone.util.js';

type ExpandKey = 'recentAppointments' | 'upcomingAppointments';
const RECENT_LIMIT = 5;
const UPCOMING_LIMIT = 3;
const APPOINTMENT_PAGE_SIZE = 20;

@Injectable()
export class CustomersService extends BaseTenantService {
  constructor(
    prisma: PrismaService,
    cls: ClsService,
    private readonly outbox: OutboxService,
  ) {
    super(prisma, cls);
  }

  private buildPayload(
    customer: {
      id: string;
      name: string;
      phone: string;
      email: string | null;
    },
    source?: CustomerEventPayload['source'],
  ): CustomerEventPayload {
    return {
      customerId: customer.id,
      businessId: this.businessId,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      ...(source ? { source } : {}),
    };
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  async create(dto: CreateCustomerDto) {
    const phone = toE164(dto.phone);
    try {
      const created = await this.prisma.db.customer.create({
        data: {
          name: dto.name,
          phone,
          email: dto.email ?? null,
          notes: dto.notes ?? null,
        } as never,
      });
      await this.outbox.enqueue(
        CustomerEvents.Created,
        this.buildPayload(created, 'dashboard'),
      );
      this.outbox.kickFlush();
      return created;
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new UniqueViolationError(
          'A customer with this phone already exists',
          [{ field: 'phone', code: 'taken', message: phone }],
        );
      }
      throw e;
    }
  }

  async findAll(query: ListCustomersQueryDto) {
    const { page, limit = 20, search, email, sort, cursor } = query;

    const baseWhere: Record<string, unknown> = { deletedAt: null };
    if (email) baseWhere['email'] = email;
    if (query.phone) baseWhere['phone'] = toE164(query.phone);
    if (search) {
      baseWhere['OR'] = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const expand = this.parseExpand(query.expand);
    const include = this.buildInclude(expand);

    // Cursor path (preferred — see D81). Response shape:
    // `{data, has_more, next_cursor}` matching conversations / audit.
    if (cursor !== undefined && cursor.length > 0) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        throw new ValidationError('Invalid cursor', [
          { field: 'cursor', code: 'invalid_cursor' },
        ]);
      }
      const where = { ...baseWhere, ...cursorWhere(decoded) };
      const rows = await this.prisma.db.customer.findMany({
        where,
        orderBy: keysetOrderBy(),
        take: takePlusOne(limit),
        include,
      });
      return slicePage(rows as Array<{ id: string; createdAt: Date }>, limit);
    }

    // Legacy offset path. Kept until dashboard migrates fully to cursor.
    // COUNT(*) is the expensive half — acceptable while tenants stay
    // small. Deprecated via `@ApiProperty({deprecated: true})` on `page`.
    const effectivePage = page ?? 1;
    const skip = (effectivePage - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.db.customer.findMany({
        where: baseWhere,
        skip,
        take: limit,
        orderBy: this.parseSort(sort),
        include,
      }),
      this.prisma.db.customer.count({ where: baseWhere }),
    ]);

    return { data, total, page: effectivePage, limit };
  }

  async findOne(id: string, expandRaw?: string) {
    const expand = this.parseExpand(expandRaw);
    const customer = await this.prisma.db.customer.findFirst({
      where: { id, deletedAt: null },
      include: this.buildInclude(expand),
    });
    if (!customer) {
      throw new NotFoundError('Customer not found', [
        {
          field: 'id',
          code: 'not_found',
          message: `No customer with id ${id}`,
        },
      ]);
    }
    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto) {
    await this.findOne(id);
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.email !== undefined) patch['email'] = dto.email;
    if (dto.notes !== undefined) patch['notes'] = dto.notes;
    if (dto.phone !== undefined) patch['phone'] = toE164(dto.phone);
    try {
      const updated = await this.prisma.db.customer.update({
        where: { id },
        data: patch as never,
      });
      await this.outbox.enqueue(
        CustomerEvents.Updated,
        this.buildPayload(updated, 'dashboard'),
      );
      this.outbox.kickFlush();
      return updated;
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new UniqueViolationError(
          'A customer with this phone already exists',
          [{ field: 'phone', code: 'taken' }],
        );
      }
      throw e;
    }
  }

  /** Soft delete: preserves PII for reports. Use `purge` for GDPR. */
  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.db.customer.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { message: 'Customer deleted' };
  }

  /**
   * GDPR Article 17 compliance. Anonymizes PII while preserving the row
   * and its FK references (appointments, payments) so business aggregates
   * stay consistent. The customer becomes "[Deleted]" in any listing.
   */
  async purge(id: string) {
    await this.findOne(id);
    await this.prisma.db.customer.update({
      where: { id },
      data: {
        name: '[Deleted]',
        phone: `deleted-${id}`, // keep unique constraint happy
        email: null,
        notes: null,
        stripeCustomerId: null,
        stripePaymentMethodId: null,
        cardLast4: null,
        cardBrand: null,
        deletedAt: new Date(),
      },
    });
    return { message: 'Customer anonymized (GDPR purge)' };
  }

  // ── Find-or-create (voice / WhatsApp / chat agent) ─────────────────

  /**
   * Idempotent entry point for IA agents. Returns the existing customer or
   * creates a new one in a single round-trip, plus the context the agent
   * needs (recent + upcoming appointments).
   *
   * `created` tells the controller whether to return 200 (existed) or 201
   * (created), mirroring the Stripe/HubSpot upsert convention.
   *
   * Race safety: the unique constraint `(businessId, phone)` is the source
   * of truth. If two concurrent calls try to create the same customer, one
   * wins and the other gets P2002 — we catch it and re-fetch.
   */
  async findOrCreate(dto: FindOrCreateCustomerDto) {
    const phone = toE164(dto.phone);

    let customer = await this.prisma.db.customer.findFirst({
      where: { phone, deletedAt: null },
    });
    let created = false;

    if (!customer) {
      try {
        customer = await this.prisma.db.customer.create({
          data: {
            name: dto.name ?? 'Unknown',
            phone,
          } as never,
        });
        created = true;
      } catch (e: unknown) {
        if ((e as { code?: string })?.code === 'P2002') {
          // Race: another tx created it between our findFirst and create.
          customer = await this.prisma.db.customer.findFirst({
            where: { phone, deletedAt: null },
          });
          if (!customer) {
            throw new NotFoundError(
              'Customer disappeared after concurrent create',
            );
          }
        } else {
          throw e;
        }
      }
    }

    // Emit ONLY when we actually materialized a new row. A plain find
    // doesn't change state so no event fires. Source = 'findOrCreate'
    // so downstream consumers can tell this came from an agent path.
    if (created) {
      await this.outbox.enqueue(
        CustomerEvents.Created,
        this.buildPayload(customer, 'findOrCreate'),
      );
      this.outbox.kickFlush();
    }

    const [recentAppointments, upcomingAppointments] = await Promise.all([
      this.prisma.db.appointment.findMany({
        where: { customerId: customer.id },
        orderBy: { startTime: 'desc' },
        take: RECENT_LIMIT,
      }),
      this.prisma.db.appointment.findMany({
        where: {
          customerId: customer.id,
          startTime: { gte: new Date() },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
        orderBy: { startTime: 'asc' },
        take: UPCOMING_LIMIT,
      }),
    ]);

    return { customer, created, recentAppointments, upcomingAppointments };
  }

  // ── Appointments listing ───────────────────────────────────────────

  async listAppointments(
    customerId: string,
    cursor?: string,
    limit = APPOINTMENT_PAGE_SIZE,
  ) {
    await this.findOne(customerId);
    const rows = await this.prisma.db.appointment.findMany({
      where: { customerId },
      orderBy: { startTime: 'desc' },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.id : null;
    return { data, nextCursor };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private parseExpand(raw?: string): Set<ExpandKey> {
    const out = new Set<ExpandKey>();
    if (!raw) return out;
    for (const token of raw.split(',').map((t) => t.trim())) {
      if (token === 'recentAppointments' || token === 'upcomingAppointments') {
        out.add(token);
      }
    }
    return out;
  }

  private buildInclude(expand: Set<ExpandKey>) {
    if (expand.size === 0) return undefined;
    // Both expansions hit the same relation with different filters; Prisma
    // can't apply two different `where`s to one relation, so we denormalize
    // in the app layer on findOne. For findAll, we use a single "recent"
    // list — showing upcoming in list rows is rare UX.
    if (expand.has('recentAppointments') || expand.has('upcomingAppointments')) {
      return {
        appointments: {
          orderBy: { startTime: 'desc' as const },
          take: RECENT_LIMIT,
        },
      };
    }
    return undefined;
  }

  private parseSort(sort?: string): Record<string, 'asc' | 'desc'> {
    const WHITELIST = new Set(['name', 'createdAt', 'updatedAt']);
    if (!sort) return { createdAt: 'desc' };
    const desc = sort.startsWith('-');
    const field = desc ? sort.slice(1) : sort;
    if (!WHITELIST.has(field)) return { createdAt: 'desc' };
    return { [field]: desc ? 'desc' : 'asc' };
  }
}
