import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ulid } from 'ulid';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';
import {
  ConflictError,
  NotFoundError,
  UniqueViolationError,
} from '../common/errors/index.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { UpdateStaffDto } from './dto/update-staff.dto.js';
import { ListStaffQueryDto } from './dto/list-staff-query.dto.js';
import { AssignServiceDto } from './dto/assign-service.dto.js';
import { ReplaceServicesDto } from './dto/replace-services.dto.js';
import { ReplaceAvailabilityDto } from './dto/replace-availability.dto.js';
import { InviteStaffDto } from './dto/invite-staff.dto.js';
import { parseExpand, StaffExpand } from './dto/expand.js';

@Injectable()
export class StaffService extends BaseTenantService {
  constructor(prisma: PrismaService, cls: ClsService) {
    super(prisma, cls);
  }

  // ── Core CRUD ───────────────────────────────────────────────────────────

  async create(dto: CreateStaffDto) {
    return this.prisma.db.staff.create({ data: dto as never });
  }

  async findAll(query: ListStaffQueryDto) {
    const { page = 1, limit = 20, isActive, serviceId, search, sort } = query;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { deletedAt: null };
    if (isActive !== undefined) where['isActive'] = isActive;
    if (serviceId) {
      where['staffServices'] = { some: { serviceId } };
    }
    if (search) {
      where['OR'] = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const expand = parseExpand(query.expand);
    const include = this.buildInclude(expand);

    const [data, total] = await Promise.all([
      this.prisma.db.staff.findMany({
        where,
        skip,
        take: limit,
        orderBy: this.parseSort(sort),
        include,
      }),
      this.prisma.db.staff.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: string, expandRaw?: string) {
    const expand = parseExpand(expandRaw);
    const staff = await this.prisma.db.staff.findFirst({
      where: { id, deletedAt: null },
      include: this.buildInclude(expand),
    });
    if (!staff) {
      throw new NotFoundError('Staff not found', [
        { field: 'id', code: 'not_found', message: `No staff with id ${id}` },
      ]);
    }
    return staff;
  }

  async update(id: string, dto: UpdateStaffDto) {
    await this.findOne(id);
    return this.prisma.db.staff.update({
      where: { id },
      data: dto as never,
    });
  }

  /**
   * Soft-delete a staff member.
   *
   * Guardrail: if the staff has future appointments, refuse with a 409 unless
   * `force` is true. With `force`, we cancel future appointments with reason
   * "staff_removed" in the same transaction so the two stay consistent.
   */
  async remove(id: string, force = false) {
    await this.findOne(id);
    const linkedUser = await this.prisma.db.user.findFirst({
      where: { staffId: id },
      select: { id: true },
    });

    const futureAppointmentsCount = await this.prisma.db.appointment.count({
      where: {
        staffId: id,
        startTime: { gte: new Date() },
        status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
      },
    });

    if (futureAppointmentsCount > 0 && !force) {
      throw new ConflictError(
        'Staff has future appointments. Pass ?force=true to cancel them.',
        { futureAppointmentsCount },
      );
    }

    // One interactive tx — the request is already inside the interceptor's
    // tx, so this delegates to it (Prisma reuses the current tx client).
    if (futureAppointmentsCount > 0) {
      await this.prisma.db.appointment.updateMany({
        where: {
          staffId: id,
          startTime: { gte: new Date() },
          status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
        },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: 'staff_removed',
        },
      });
    }

    await this.prisma.db.staff.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    // Deactivate linked dashboard user (audit trail preserved).
    if (linkedUser) {
      await this.prisma.db.user.update({
        where: { id: linkedUser.id },
        data: { isActive: false },
      });
    }

    return { message: 'Staff deleted', cancelledAppointments: futureAppointmentsCount };
  }

  // ── Service assignments ────────────────────────────────────────────────

  async listServices(staffId: string) {
    await this.findOne(staffId);
    return this.prisma.db.staffService.findMany({
      where: { staffId },
      include: { service: true },
    });
  }

  async assignService(staffId: string, dto: AssignServiceDto) {
    await this.findOne(staffId);
    await this.assertServiceExists(dto.serviceId);

    try {
      return await this.prisma.db.staffService.create({
        data: {
          staffId,
          serviceId: dto.serviceId,
          customDuration: dto.customDuration ?? null,
          customPrice: dto.customPrice ?? null,
        } as never,
      });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new UniqueViolationError(
          'Service is already assigned to this staff',
          [{ field: 'serviceId', code: 'already_assigned' }],
        );
      }
      throw e;
    }
  }

  async replaceServices(staffId: string, dto: ReplaceServicesDto) {
    await this.findOne(staffId);
    // Validate referenced services all exist first — fail fast before we
    // drop the existing assignments.
    const ids = Array.from(new Set(dto.items.map((i) => i.serviceId)));
    const found = await this.prisma.db.service.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      const known = new Set(found.map((s) => s.id));
      const missing = ids.filter((id) => !known.has(id));
      throw new NotFoundError(
        'One or more services were not found',
        missing.map((id) => ({ field: 'serviceId', code: 'not_found', message: id })),
      );
    }

    await this.prisma.db.staffService.deleteMany({ where: { staffId } });
    if (dto.items.length > 0) {
      await this.prisma.db.staffService.createMany({
        data: dto.items.map((i) => ({
          staffId,
          serviceId: i.serviceId,
          customDuration: i.customDuration ?? null,
          customPrice: i.customPrice ?? null,
        })) as never,
      });
    }

    return this.prisma.db.staffService.findMany({
      where: { staffId },
      include: { service: true },
    });
  }

  async removeService(staffId: string, serviceId: string) {
    await this.findOne(staffId);
    const { count } = await this.prisma.db.staffService.deleteMany({
      where: { staffId, serviceId },
    });
    if (count === 0) {
      throw new NotFoundError('Service assignment not found');
    }
    return { message: 'Service unassigned' };
  }

  // ── Availability ──────────────────────────────────────────────────────

  async listAvailability(staffId: string) {
    await this.findOne(staffId);
    return this.prisma.db.staffAvailability.findMany({
      where: { staffId },
      orderBy: { dayOfWeek: 'asc' },
    });
  }

  async replaceAvailability(staffId: string, dto: ReplaceAvailabilityDto) {
    await this.findOne(staffId);

    // Reject duplicate dayOfWeek in payload early — DB unique constraint
    // would also catch this but with a worse error.
    const seen = new Set<string>();
    for (const it of dto.items) {
      if (seen.has(it.dayOfWeek)) {
        throw new UniqueViolationError(
          'Duplicate dayOfWeek in availability payload',
          [{ field: 'dayOfWeek', code: 'duplicate', message: it.dayOfWeek }],
        );
      }
      if (it.startTime >= it.endTime) {
        throw new ConflictError(
          'startTime must be before endTime',
          { dayOfWeek: it.dayOfWeek, startTime: it.startTime, endTime: it.endTime },
        );
      }
      seen.add(it.dayOfWeek);
    }

    await this.prisma.db.staffAvailability.deleteMany({ where: { staffId } });
    if (dto.items.length > 0) {
      await this.prisma.db.staffAvailability.createMany({
        data: dto.items.map((i) => ({
          staffId,
          dayOfWeek: i.dayOfWeek,
          startTime: i.startTime,
          endTime: i.endTime,
          isActive: i.isActive ?? true,
        })) as never,
      });
    }

    return this.prisma.db.staffAvailability.findMany({
      where: { staffId },
      orderBy: { dayOfWeek: 'asc' },
    });
  }

  // ── Invitation (stub — real email/magic-link flow later) ───────────────

  /**
   * Stub: records the intent to invite. Wire the real flow (generate signed
   * token, send email, create pending User row) when the email system lands.
   * See docs/deferred-work.md.
   */
  async invite(staffId: string, dto: InviteStaffDto) {
    await this.findOne(staffId);
    // Intentional no-op at this stage — returns the would-be invitation id.
    return {
      invitationId: ulid(),
      email: dto.email,
      role: dto.role ?? 'STAFF',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'pending_implementation',
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private buildInclude(expand: Set<StaffExpand>) {
    const include: Record<string, unknown> = {};
    if (expand.has('services')) {
      include['staffServices'] = { include: { service: true } };
    }
    if (expand.has('availability')) {
      include['availabilities'] = { orderBy: { dayOfWeek: 'asc' } };
    }
    if (expand.has('blockedTimes')) {
      include['blockedTimes'] = {
        where: { endTime: { gte: new Date() } },
        orderBy: { startTime: 'asc' },
      };
    }
    if (expand.has('user')) {
      include['user'] = {
        select: { id: true, email: true, role: true, isActive: true },
      };
    }
    return Object.keys(include).length > 0 ? include : undefined;
  }

  /**
   * Parses the RFC-style `sort` query string:
   *   ?sort=name         → { name: 'asc' }
   *   ?sort=-createdAt   → { createdAt: 'desc' }
   * Only whitelisted fields are accepted; anything else falls back to name asc.
   */
  private parseSort(sort?: string): Record<string, 'asc' | 'desc'> {
    const WHITELIST = new Set(['name', 'createdAt', 'updatedAt']);
    if (!sort) return { name: 'asc' };
    const desc = sort.startsWith('-');
    const field = desc ? sort.slice(1) : sort;
    if (!WHITELIST.has(field)) return { name: 'asc' };
    return { [field]: desc ? 'desc' : 'asc' };
  }

  private async assertServiceExists(serviceId: string) {
    const svc = await this.prisma.db.service.findFirst({
      where: { id: serviceId, deletedAt: null },
      select: { id: true },
    });
    if (!svc) {
      throw new NotFoundError('Service not found', [
        { field: 'serviceId', code: 'not_found', message: serviceId },
      ]);
    }
  }
}
