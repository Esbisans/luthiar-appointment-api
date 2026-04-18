import { DayOfWeek } from '../../generated/prisma/client.js';
import type {
  AvailabilityResponse,
  DaySlotsDto,
  DayStatus,
  NextSlotsResponse,
  SlotDto,
} from '../dto/availability-response.dto.js';
import {
  fitsIn,
  intersect,
  merge,
  subtract,
  type Interval,
} from './interval.util.js';
import {
  enumerateDates,
  localHHMMToUtcMs,
  MINUTE_MS,
  utcMsToIsoWithOffset,
  weekdayOfDate,
  windowToUtcInterval,
} from './slot-grid.util.js';

// ── Inputs (pure DTOs — NOT Prisma types) ───────────────────────────────

export interface EngineBusinessHour {
  dayOfWeek: DayOfWeek;
  startTime: string; // HH:MM
  endTime: string;
  isOpen: boolean;
}

export interface EngineStaffAvailability {
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  isActive: boolean;
}

export interface EngineStaff {
  id: string;
  isActive: boolean;
  customDuration: number | null;
  availabilities: EngineStaffAvailability[];
}

export interface EngineBlockedTime {
  staffId: string | null; // null = business-wide
  startUtcMs: number;
  endUtcMs: number;
}

export interface EngineHoliday {
  /** YYYY-MM-DD (UTC date). */
  dateISO: string;
  isRecurring: boolean;
}

export interface EngineAppointment {
  staffId: string;
  startUtcMs: number;
  endUtcMs: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}

export interface EngineContext {
  timezone: string;
  business: {
    cancellationHours: number;
  };
  service: {
    id: string;
    durationMin: number;
    /**
     * Slot grid step in minutes. Same value used by `POST /appointments`
     * for boundary validation — MUST stay in sync to prevent the
     * Cal.com #24260 "slots endpoint shows times the bookings endpoint
     * rejects" drift bug.
     */
    slotIntervalMin: number;
    bufferBeforeMin: number;
    bufferAfterMin: number;
  };
  businessHours: EngineBusinessHour[];
  staff: EngineStaff[];
  blockedTimes: EngineBlockedTime[];
  holidays: EngineHoliday[];
  appointments: EngineAppointment[];
  /** epoch-ms treated as "now" — parameterized so tests can inject. */
  nowMs: number;
}

export interface EngineParams {
  fromISO: string; // YYYY-MM-DD
  toISO: string;
  staffIdFilter?: string;
  granularityMin: number;
  format: 'time' | 'range';
  /** Timezone to present response in. Usually same as context.timezone. */
  outputTimezone: string;
}

// ── Core engine ─────────────────────────────────────────────────────────

export function computeAvailability(
  ctx: EngineContext,
  params: EngineParams,
): AvailabilityResponse {
  const days: Record<string, DaySlotsDto> = {};

  const earliestAllowedMs =
    ctx.nowMs + ctx.business.cancellationHours * 60 * 60 * 1000;

  const candidateStaff = ctx.staff.filter(
    (s) =>
      s.isActive &&
      (params.staffIdFilter ? s.id === params.staffIdFilter : true),
  );

  // Per-day compute
  for (const dateISO of enumerateDates(
    params.fromISO,
    params.toISO,
    ctx.timezone,
  )) {
    days[dateISO] = computeDay(
      ctx,
      params,
      dateISO,
      candidateStaff,
      earliestAllowedMs,
    );
  }

  return {
    timezone: params.outputTimezone,
    service: { id: ctx.service.id, duration: ctx.service.durationMin },
    days,
  };
}

function computeDay(
  ctx: EngineContext,
  params: EngineParams,
  dateISO: string,
  candidateStaff: EngineStaff[],
  earliestAllowedMs: number,
): DaySlotsDto {
  // Past date → short-circuit.
  const todayMs = localHHMMToUtcMs(dateISO, '23:59', ctx.timezone);
  if (todayMs !== null && todayMs < ctx.nowMs) {
    return { status: 'past', slots: [] };
  }

  // Holiday check (including recurring: match MM-DD).
  const [, mm, dd] = dateISO.split('-');
  const mmdd = `${mm}-${dd}`;
  const isHoliday = ctx.holidays.some((h) => {
    if (h.dateISO === dateISO) return true;
    if (!h.isRecurring) return false;
    const [, hmm, hdd] = h.dateISO.split('-');
    return `${hmm}-${hdd}` === mmdd;
  });
  if (isHoliday) return { status: 'holiday', slots: [] };

  const weekday = weekdayOfDate(dateISO, ctx.timezone);

  // Business-hours windows for this day (multi-window supported).
  const bhWindowsLocal = ctx.businessHours.filter(
    (bh) => bh.isOpen && bh.dayOfWeek === weekday,
  );
  if (bhWindowsLocal.length === 0) return { status: 'closed', slots: [] };

  const bhIntervals: Interval[] = [];
  for (const w of bhWindowsLocal) {
    const iv = windowToUtcInterval(dateISO, w.startTime, w.endTime, ctx.timezone);
    if (iv) bhIntervals.push(iv);
  }
  const businessWindows = merge(bhIntervals);
  if (businessWindows.length === 0) return { status: 'closed', slots: [] };

  // Day range in UTC (slight over-shoot either side is fine for filters).
  const dayStartMs = businessWindows[0]!.start;
  const dayEndMs = businessWindows[businessWindows.length - 1]!.end;

  // Business-wide blocked times (apply to every staff).
  const businessWideBlocks = ctx.blockedTimes
    .filter(
      (b) =>
        b.staffId === null && b.endUtcMs > dayStartMs && b.startUtcMs < dayEndMs,
    )
    .map<Interval>((b) => ({ start: b.startUtcMs, end: b.endUtcMs }));

  // Build per-staff free intervals.
  interface StaffFree {
    staffId: string;
    free: Interval[];
    effectiveDurationMin: number;
  }
  const perStaffFree: StaffFree[] = [];

  for (const staff of candidateStaff) {
    const avails = staff.availabilities.filter(
      (a) => a.isActive && a.dayOfWeek === weekday,
    );
    if (avails.length === 0) continue;

    const availIntervals: Interval[] = [];
    for (const a of avails) {
      const iv = windowToUtcInterval(
        dateISO,
        a.startTime,
        a.endTime,
        ctx.timezone,
      );
      if (iv) availIntervals.push(iv);
    }
    const work = intersect(businessWindows, availIntervals);
    if (work.length === 0) continue;

    // Busy = staff-specific blocks + business-wide blocks + staff appointments
    // (expanded with their own service's buffers).
    const staffBlocks = ctx.blockedTimes
      .filter(
        (b) =>
          b.staffId === staff.id &&
          b.endUtcMs > dayStartMs &&
          b.startUtcMs < dayEndMs,
      )
      .map<Interval>((b) => ({ start: b.startUtcMs, end: b.endUtcMs }));

    const apptBusy = ctx.appointments
      .filter(
        (a) =>
          a.staffId === staff.id &&
          a.endUtcMs > dayStartMs &&
          a.startUtcMs < dayEndMs,
      )
      .map<Interval>((a) => ({
        start: a.startUtcMs - a.bufferBeforeMin * MINUTE_MS,
        end: a.endUtcMs + a.bufferAfterMin * MINUTE_MS,
      }));

    const busy = merge([...businessWideBlocks, ...staffBlocks, ...apptBusy]);
    const free = subtract(work, busy);

    const effectiveDurationMin = staff.customDuration ?? ctx.service.durationMin;
    perStaffFree.push({ staffId: staff.id, free, effectiveDurationMin });
  }

  if (perStaffFree.length === 0) return { status: 'open', slots: [] };

  // Slot grid. Step over the span of business windows.
  const slots: SlotDto[] = [];
  const stepMs = params.granularityMin * MINUTE_MS;
  const slotBufferBefore = ctx.service.bufferBeforeMin * MINUTE_MS;
  const slotBufferAfter = ctx.service.bufferAfterMin * MINUTE_MS;

  // Iterate over each business window independently to avoid emitting slots
  // that cross a closed period (e.g. lunch 14-16).
  for (const bw of businessWindows) {
    for (let start = bw.start; start + stepMs <= bw.end + 1; start += stepMs) {
      // Candidate slot needs to fit the queried service + ITS buffers.
      // Per-staff duration may differ via customDuration.
      const slotStaffIds: string[] = [];
      for (const p of perStaffFree) {
        const end = start + p.effectiveDurationMin * MINUTE_MS;
        if (end > bw.end) continue; // does not fit inside this window
        if (start < earliestAllowedMs) continue; // cancellation cutoff
        const cand: Interval = {
          start: start - slotBufferBefore,
          end: end + slotBufferAfter,
        };
        if (fitsIn(p.free, cand)) slotStaffIds.push(p.staffId);
      }
      if (slotStaffIds.length > 0) {
        const slot: SlotDto = {
          start: utcMsToIsoWithOffset(start, params.outputTimezone),
          staffIds: slotStaffIds,
        };
        if (params.format === 'range') {
          // Use service's default duration for range display; staff-specific
          // durations are exposed via staffIds + separate lookup if needed.
          slot.end = utcMsToIsoWithOffset(
            start + ctx.service.durationMin * MINUTE_MS,
            params.outputTimezone,
          );
        }
        slots.push(slot);
      }
    }
  }

  return {
    status: 'open' as DayStatus,
    slots,
  };
}

// ── /availability/next helper — just flattens the response ──────────────

export function computeNextSlots(
  ctx: EngineContext,
  fromISO: string,
  toISO: string,
  options: {
    staffIdFilter?: string;
    limit: number;
    outputTimezone: string;
  },
): NextSlotsResponse {
  const all = computeAvailability(ctx, {
    fromISO,
    toISO,
    staffIdFilter: options.staffIdFilter,
    granularityMin: ctx.service.slotIntervalMin,
    format: 'time',
    outputTimezone: options.outputTimezone,
  });

  const flat: SlotDto[] = [];
  for (const dateKey of Object.keys(all.days).sort()) {
    const day = all.days[dateKey]!;
    if (day.status !== 'open') continue;
    for (const s of day.slots) {
      flat.push(s);
      if (flat.length >= options.limit) {
        return {
          timezone: all.timezone,
          service: all.service,
          slots: flat,
        };
      }
    }
  }
  return { timezone: all.timezone, service: all.service, slots: flat };
}
