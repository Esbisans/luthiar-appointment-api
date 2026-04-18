import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';

const SCHEMA_VERSION = '2025-04-16';

/**
 * Shape returned by GET /agent/context. Keep this stable — the voice
 * agent parses it at startup and the field names end up in the LLM
 * system prompt. Breaking changes require bumping `schemaVersion`.
 */
export interface AgentContextBundle {
  schemaVersion: string;
  business: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    locale: string;
    phone: string | null;
    address: string | null;
  };
  policy: {
    cancellationWindowHours: number;
    refundEnabled: boolean;
  };
  hours: Array<{
    weekday: string;
    open: string;
    close: string;
  }>;
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    durationMinutes: number;
    priceCents: number;
    currency: string;
  }>;
  staff: Array<{
    id: string;
    name: string;
    serviceIds: string[];
  }>;
  capabilities: {
    onlineBooking: boolean;
    voice: boolean;
    whatsapp: boolean;
  };
}

@Injectable()
export class AgentContextService extends BaseTenantService {
  constructor(prisma: PrismaService, cls: ClsService) {
    super(prisma, cls);
  }

  async buildContext(): Promise<{ bundle: AgentContextBundle; etag: string }> {
    // Two-step pull: (1) business + businessHours in one, (2) services/staff
    // via their own tenant-scoped queries. We do this instead of a single
    // `business.findFirst({include: services, staff})` because nested
    // `include.where` on soft-deleted / isActive filters interacts poorly
    // with the tenant extension's where-injection for child models.
    const business = (await this.prisma.db.business.findFirstOrThrow({
      include: {
        businessHours: {
          where: { isOpen: true },
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
        },
      },
    } as never)) as unknown as {
      id: string;
      name: string;
      slug: string;
      timezone: string;
      country: string;
      phone: string | null;
      address: string | null;
      cancellationHours: number;
      refundEnabled: boolean;
      businessHours: Array<{
        dayOfWeek: string;
        startTime: string;
        endTime: string;
      }>;
    };

    const [services, staff] = await Promise.all([
      this.prisma.db.service.findMany({
        where: { deletedAt: null, isActive: true } as never,
        orderBy: { name: 'asc' },
        include: { staffServices: { select: { staffId: true } } },
      } as never),
      this.prisma.db.staff.findMany({
        where: { deletedAt: null, isActive: true } as never,
        orderBy: { name: 'asc' },
        include: { staffServices: { select: { serviceId: true } } },
      } as never),
    ]) as unknown as [
      Array<{
        id: string;
        name: string;
        description: string | null;
        duration: number;
        price: unknown;
        currency: string;
      }>,
      Array<{ id: string; name: string; staffServices: Array<{ serviceId: string }> }>,
    ];

    const bundle: AgentContextBundle = {
      schemaVersion: SCHEMA_VERSION,
      business: {
        id: business.id,
        name: business.name,
        slug: business.slug,
        timezone: business.timezone,
        currency: 'MXN', // Per-business currency not modelled yet; defer
        locale: business.country === 'MX' ? 'es-MX' : 'en-US',
        phone: business.phone,
        address: business.address,
      },
      policy: {
        cancellationWindowHours: business.cancellationHours,
        refundEnabled: business.refundEnabled,
      },
      hours: business.businessHours.map((h) => ({
        weekday: h.dayOfWeek,
        open: h.startTime,
        close: h.endTime,
      })),
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        durationMinutes: s.duration,
        priceCents: Math.round(Number(s.price) * 100),
        currency: s.currency,
      })),
      staff: staff.map((s) => ({
        id: s.id,
        name: s.name,
        serviceIds: s.staffServices.map((ss) => ss.serviceId),
      })),
      capabilities: {
        onlineBooking: true,
        voice: true,
        whatsapp: false, // Flip when Fase 5 lands
      },
    };

    // Content-hash ETag: changes iff the serialised bundle changes.
    // Cheap to compute (<1ms) and side-steps a `contextVersion` column
    // that would need Prisma middleware on 5 tables to stay correct.
    const json = JSON.stringify(bundle);
    const etag = `W/"${createHash('sha1').update(json).digest('hex').slice(0, 16)}"`;

    return { bundle, etag };
  }
}
