import { DateTime } from 'luxon';
import { ValidationError } from '../../common/errors/index.js';

/**
 * Small helpers over Luxon so all timezone-sensitive logic uses the same
 * conventions. Strings are always `HH:MM` 24-hour; zones are IANA names
 * like `America/Mexico_City`.
 *
 * The availability engine (future) will convert these local wall-clock
 * strings to concrete UTC windows for a specific date.
 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function assertHHMM(value: string, field = 'time'): void {
  if (!HHMM.test(value)) {
    throw new ValidationError(`${field} must be HH:MM (24h)`, [
      { field, code: 'invalid_time_format', message: value },
    ]);
  }
}

/** Returns true if `end` is strictly after `start` on the same day. */
export function isOrderedSameDay(start: string, end: string): boolean {
  return start < end;
}

/** `HH:MM` → minutes since midnight. */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => Number.parseInt(n, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Checks whether two [start, end) intervals overlap in minutes. */
export function intervalsOverlap(
  a: { start: string; end: string },
  b: { start: string; end: string },
): boolean {
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
}

/**
 * Normalize a date string (YYYY-MM-DD) to a UTC midnight DateTime for
 * Holiday storage. Holidays are whole-day and timezone-independent
 * (they refer to a calendar date, not a specific moment).
 */
export function toHolidayDate(isoDate: string): Date {
  const dt = DateTime.fromISO(isoDate, { zone: 'utc' }).startOf('day');
  if (!dt.isValid) {
    throw new ValidationError('date must be a valid ISO date (YYYY-MM-DD)', [
      { field: 'date', code: 'invalid_date', message: isoDate },
    ]);
  }
  return dt.toJSDate();
}

export const DAY_ORDER = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;
