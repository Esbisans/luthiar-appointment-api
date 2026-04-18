import { Injectable } from '@nestjs/common';
import type { AvailabilityResponse } from '../dto/availability-response.dto.js';

/**
 * Cache facade for availability responses.
 *
 * v1 (this file): stub that always misses. Keeps the call site symmetrical
 * with the final Redis-backed implementation so we don't refactor consumers
 * when the cache ships.
 *
 * v2 will be in-memory LRU (TTL 10s).
 * v3 will be Redis with active invalidation on Appointment/BlockedTime/
 * StaffAvailability writes. See docs/deferred-work.md D26.
 */
@Injectable()
export class AvailabilityCacheService {
  async get(_key: string): Promise<AvailabilityResponse | null> {
    return null;
  }

  async set(_key: string, _value: AvailabilityResponse): Promise<void> {
    /* no-op */
  }

  keyFor(parts: {
    businessId: string;
    serviceId: string;
    staffId?: string;
    fromISO: string;
    toISO: string;
    timezone: string;
    granularity: number;
    format: string;
  }): string {
    return [
      parts.businessId,
      parts.serviceId,
      parts.staffId ?? '*',
      parts.fromISO,
      parts.toISO,
      parts.timezone,
      parts.granularity,
      parts.format,
    ].join(':');
  }
}
