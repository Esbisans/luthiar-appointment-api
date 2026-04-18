import { DateTime } from 'luxon';
import { DayOfWeek } from '../../generated/prisma/client.js';
import type { Interval } from './interval.util.js';

/**
 * Timezone-aware helpers for the availability engine.
 *
 * Rules:
 *   • Business hours / staff availability are stored as `HH:MM` **local**
 *     to the business timezone. They have no UTC meaning on their own.
 *   • Given a calendar date + local `HH:MM` + IANA tz, we resolve a
 *     concrete UTC millisecond. Luxon handles DST: a skipped hour (spring
 *     forward) yields an invalid DateTime; ambiguous hours (fall back)
 *     resolve to the later offset (Luxon default).
 *   • If the wall-clock resolves to `invalid`, we return `null` — the
 *     caller drops that window/slot. This matches Google Calendar and
 *     matters in March for US/MX and October for EU.
 */

const DAY_TO_WEEKDAY: Record<DayOfWeek, number> = {
  // Luxon: 1 = Monday ... 7 = Sunday
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
};

export function weekdayOfDate(dateISO: string, timezone: string): DayOfWeek {
  const dt = DateTime.fromISO(dateISO, { zone: timezone });
  const weekday = dt.weekday;
  const entry = (Object.entries(DAY_TO_WEEKDAY) as [DayOfWeek, number][]).find(
    ([, n]) => n === weekday,
  );
  return entry?.[0] ?? 'MONDAY';
}

export function isValidTimezone(tz: string): boolean {
  // Luxon returns invalid DateTime with a reason "unsupported zone" for bad IANA.
  return DateTime.now().setZone(tz).isValid;
}

/**
 * Parse `HH:MM` and materialize as a UTC epoch-ms anchored to `dateISO` in
 * `timezone`. Returns `null` on DST gap (skipped hour) or invalid input.
 */
export function localHHMMToUtcMs(
  dateISO: string,
  hhmm: string,
  timezone: string,
): number | null {
  const [hStr, mStr] = hhmm.split(':');
  const hour = Number.parseInt(hStr ?? '', 10);
  const minute = Number.parseInt(mStr ?? '', 10);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const [y, mo, d] = dateISO.split('-').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    return null;
  }
  const dt = DateTime.fromObject(
    { year: y!, month: mo!, day: d!, hour, minute, second: 0, millisecond: 0 },
    { zone: timezone },
  );
  if (!dt.isValid) return null;

  // Round-trip check: Luxon does NOT return invalid for DST gaps — it shifts
  // the time into the next valid instant. We detect gaps by confirming that
  // the resolved DateTime still reads as the requested wall-clock in its
  // zone. Anything else means we fell into a DST gap and must drop the slot.
  if (dt.hour !== hour || dt.minute !== minute) return null;

  return dt.toMillis();
}

/**
 * Build an Interval (UTC ms) for a local-time window `[startHHMM, endHHMM)`
 * on a given date and timezone. Returns `null` if either endpoint is a
 * DST gap.
 */
export function windowToUtcInterval(
  dateISO: string,
  startHHMM: string,
  endHHMM: string,
  timezone: string,
): Interval | null {
  const start = localHHMMToUtcMs(dateISO, startHHMM, timezone);
  const end = localHHMMToUtcMs(dateISO, endHHMM, timezone);
  if (start === null || end === null) return null;
  if (end <= start) return null; // cross-midnight not supported yet (deferred D21)
  return { start, end };
}

/** Enumerate dates in `[fromISO, toISO]` as YYYY-MM-DD strings in `tz`. */
export function enumerateDates(
  fromISO: string,
  toISO: string,
  timezone: string,
): string[] {
  const start = DateTime.fromISO(fromISO, { zone: timezone });
  const end = DateTime.fromISO(toISO, { zone: timezone });
  if (!start.isValid || !end.isValid || end < start) return [];
  const out: string[] = [];
  let cur = start.startOf('day');
  const last = end.startOf('day');
  while (cur <= last) {
    out.push(cur.toISODate()!);
    cur = cur.plus({ days: 1 });
  }
  return out;
}

/** UTC ms → ISO-8601 with the offset of `timezone`. */
export function utcMsToIsoWithOffset(ms: number, timezone: string): string {
  return DateTime.fromMillis(ms, { zone: 'utc' })
    .setZone(timezone)
    .toISO({ suppressMilliseconds: true })!;
}

/** Millis in one minute. */
export const MINUTE_MS = 60 * 1000;
