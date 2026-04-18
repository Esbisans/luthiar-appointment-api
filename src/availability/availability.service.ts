import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';
import { AvailabilityErrors } from './availability.errors.js';
import {
  computeAvailability,
  computeNextSlots,
} from './engine/availability.engine.js';
import { isValidTimezone } from './engine/slot-grid.util.js';
import { AvailabilityContextLoader } from './loaders/availability-context.loader.js';
import { AvailabilityCacheService } from './cache/availability-cache.service.js';
import {
  GetAvailabilityQueryDto,
  GetNextSlotsQueryDto,
} from './dto/get-availability.query.dto.js';
import type {
  AvailabilityResponse,
  NextSlotsResponse,
} from './dto/availability-response.dto.js';

const MAX_RANGE_DAYS = 31;

@Injectable()
export class AvailabilityService extends BaseTenantService {
  constructor(
    prisma: PrismaService,
    cls: ClsService,
    private readonly loader: AvailabilityContextLoader,
    private readonly cache: AvailabilityCacheService,
    @InjectPinoLogger(AvailabilityService.name)
    private readonly logger: PinoLogger,
  ) {
    super(prisma, cls);
  }

  async get(query: GetAvailabilityQueryDto): Promise<AvailabilityResponse> {
    this.validateRange(query.from, query.to);

    if (query.timezone && !isValidTimezone(query.timezone)) {
      throw AvailabilityErrors.invalidTimezone(query.timezone);
    }

    const ctx = await this.loader.load({
      serviceId: query.serviceId,
      fromISO: query.from,
      toISO: query.to,
      staffIdFilter: query.staffId,
      outputTimezone: query.timezone,
    });

    const outputTimezone = query.timezone ?? ctx.timezone;
    // Default granularity comes from the Service's configured slot grid
    // so `/availability` and `POST /appointments` share the same step.
    // Query-string `?granularity=` still wins for legitimate overrides.
    const granularity = query.granularity ?? ctx.service.slotIntervalMin;
    const format = query.format ?? 'time';

    const key = this.cache.keyFor({
      businessId: this.businessId,
      serviceId: query.serviceId,
      staffId: query.staffId,
      fromISO: query.from,
      toISO: query.to,
      timezone: outputTimezone,
      granularity,
      format,
    });
    const cached = await this.cache.get(key);
    if (cached) return cached;

    const t0 = performance.now();
    const response = computeAvailability(ctx, {
      fromISO: query.from,
      toISO: query.to,
      staffIdFilter: query.staffId,
      granularityMin: granularity,
      format,
      outputTimezone,
    });
    const elapsedMs = Math.round(performance.now() - t0);

    this.logger.info(
      {
        operation: 'availability.compute',
        businessId: this.businessId,
        serviceId: query.serviceId,
        staffId: query.staffId ?? null,
        days: Object.keys(response.days).length,
        elapsedMs,
      },
      'availability computed',
    );

    await this.cache.set(key, response);
    return response;
  }

  async getNext(query: GetNextSlotsQueryDto): Promise<NextSlotsResponse> {
    const lookaheadDays = query.lookaheadDays ?? 14;
    const limit = query.limit ?? 5;

    if (query.timezone && !isValidTimezone(query.timezone)) {
      throw AvailabilityErrors.invalidTimezone(query.timezone);
    }

    // We compute from "today" in the output timezone to avoid leaking past
    // slots from yesterday to early-morning callers across timezones.
    const tz = query.timezone ?? 'utc';
    const start = DateTime.now().setZone(tz);
    const from = start.toISODate()!;
    const to = start.plus({ days: lookaheadDays }).toISODate()!;

    const ctx = await this.loader.load({
      serviceId: query.serviceId,
      fromISO: from,
      toISO: to,
      staffIdFilter: query.staffId,
      outputTimezone: query.timezone,
    });
    const outputTimezone = query.timezone ?? ctx.timezone;

    const t0 = performance.now();
    const response = computeNextSlots(ctx, from, to, {
      staffIdFilter: query.staffId,
      limit,
      outputTimezone,
    });
    const elapsedMs = Math.round(performance.now() - t0);

    this.logger.info(
      {
        operation: 'availability.next',
        businessId: this.businessId,
        serviceId: query.serviceId,
        staffId: query.staffId ?? null,
        elapsedMs,
        returned: response.slots.length,
      },
      'availability.next computed',
    );

    return response;
  }

  private validateRange(fromISO: string, toISO: string): void {
    const from = DateTime.fromISO(fromISO);
    const to = DateTime.fromISO(toISO);
    if (!from.isValid || !to.isValid) {
      throw AvailabilityErrors.invalidRange(fromISO, toISO);
    }
    if (to < from) {
      throw AvailabilityErrors.invalidRange(fromISO, toISO);
    }
    const span = to.diff(from, 'days').days;
    if (span > MAX_RANGE_DAYS) {
      throw AvailabilityErrors.rangeTooWide(MAX_RANGE_DAYS);
    }
  }
}
