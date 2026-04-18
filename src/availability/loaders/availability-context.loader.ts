import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { DateTime } from 'luxon';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BaseTenantService } from '../../common/base-tenant.service.js';
import { AvailabilityErrors } from '../availability.errors.js';
import type {
  EngineContext,
  EngineStaff,
} from '../engine/availability.engine.js';

interface LoadOptions {
  serviceId: string;
  fromISO: string;
  toISO: string;
  staffIdFilter?: string;
  outputTimezone?: string;
}

/**
 * Loads everything the engine needs in parallel, in a single tenant-scoped
 * request. Returns a fully-serialized `EngineContext` — no Prisma types
 * leak to the engine, which keeps the engine unit-testable.
 */
@Injectable()
export class AvailabilityContextLoader extends BaseTenantService {
  constructor(prisma: PrismaService, cls: ClsService) {
    super(prisma, cls);
  }

  async load(opts: LoadOptions): Promise<EngineContext> {
    const businessId = this.businessId;

    // Overshoot the UTC range by ±1 day so appointments/blocks that cross
    // the edges (due to timezone offsets) are still included.
    const timezoneGuess =
      opts.outputTimezone ?? 'America/Mexico_City'; // final TZ resolved below
    const fromUtc = DateTime.fromISO(opts.fromISO, { zone: timezoneGuess })
      .minus({ days: 1 })
      .toJSDate();
    const toUtc = DateTime.fromISO(opts.toISO, { zone: timezoneGuess })
      .plus({ days: 2 })
      .toJSDate();

    const [business, service, staffRaw, businessHours, blockedRaw, holidaysRaw, appointmentsRaw] =
      await Promise.all([
        this.prisma.db.business.findFirst({
          where: { id: businessId },
          select: { timezone: true, cancellationHours: true },
        }),
        this.prisma.db.service.findFirst({
          where: { id: opts.serviceId, deletedAt: null },
          select: {
            id: true,
            duration: true,
            bufferBefore: true,
            bufferAfter: true,
          },
        }),
        this.prisma.db.staff.findMany({
          where: {
            deletedAt: null,
            isActive: true,
            staffServices: { some: { serviceId: opts.serviceId } },
            ...(opts.staffIdFilter ? { id: opts.staffIdFilter } : {}),
          },
          select: {
            id: true,
            isActive: true,
            availabilities: {
              select: {
                dayOfWeek: true,
                startTime: true,
                endTime: true,
                isActive: true,
              },
            },
            staffServices: {
              where: { serviceId: opts.serviceId },
              select: { customDuration: true },
            },
          },
        }),
        this.prisma.db.businessHour.findMany({
          select: {
            dayOfWeek: true,
            startTime: true,
            endTime: true,
            isOpen: true,
          },
        }),
        this.prisma.db.blockedTime.findMany({
          where: {
            endTime: { gt: fromUtc },
            startTime: { lt: toUtc },
            ...(opts.staffIdFilter
              ? { OR: [{ staffId: null }, { staffId: opts.staffIdFilter }] }
              : {}),
          },
          select: {
            staffId: true,
            startTime: true,
            endTime: true,
          },
        }),
        this.prisma.db.holiday.findMany({
          select: { date: true, isRecurring: true },
        }),
        this.prisma.db.appointment.findMany({
          where: {
            status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
            endTime: { gt: fromUtc },
            startTime: { lt: toUtc },
            ...(opts.staffIdFilter ? { staffId: opts.staffIdFilter } : {}),
          },
          select: {
            staffId: true,
            startTime: true,
            endTime: true,
            service: {
              select: { bufferBefore: true, bufferAfter: true },
            },
          },
        }),
      ]);

    if (!business) {
      throw AvailabilityErrors.serviceNotFound(opts.serviceId);
    }
    if (!service) {
      throw AvailabilityErrors.serviceNotFound(opts.serviceId);
    }
    if (opts.staffIdFilter && staffRaw.length === 0) {
      throw AvailabilityErrors.staffCannotDoService(
        opts.staffIdFilter,
        opts.serviceId,
      );
    }

    const staff: EngineStaff[] = staffRaw.map((s) => ({
      id: s.id,
      isActive: s.isActive,
      customDuration: s.staffServices[0]?.customDuration ?? null,
      availabilities: s.availabilities,
    }));

    return {
      timezone: business.timezone,
      business: { cancellationHours: business.cancellationHours },
      service: {
        id: service.id,
        durationMin: service.duration,
        slotIntervalMin:
          (service as { slotIntervalMin?: number }).slotIntervalMin ?? 15,
        bufferBeforeMin: service.bufferBefore,
        bufferAfterMin: service.bufferAfter,
      },
      businessHours: businessHours.map((b) => ({
        dayOfWeek: b.dayOfWeek,
        startTime: b.startTime,
        endTime: b.endTime,
        isOpen: b.isOpen,
      })),
      staff,
      blockedTimes: blockedRaw.map((b) => ({
        staffId: b.staffId,
        startUtcMs: b.startTime.getTime(),
        endUtcMs: b.endTime.getTime(),
      })),
      holidays: holidaysRaw.map((h) => ({
        dateISO: DateTime.fromJSDate(h.date, { zone: 'utc' }).toISODate()!,
        isRecurring: h.isRecurring,
      })),
      appointments: appointmentsRaw.map((a) => ({
        staffId: a.staffId,
        startUtcMs: a.startTime.getTime(),
        endUtcMs: a.endTime.getTime(),
        bufferBeforeMin: a.service.bufferBefore,
        bufferAfterMin: a.service.bufferAfter,
      })),
      nowMs: Date.now(),
    };
  }
}
