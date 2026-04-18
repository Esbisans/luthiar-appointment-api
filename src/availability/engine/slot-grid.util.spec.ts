import {
  enumerateDates,
  isValidTimezone,
  localHHMMToUtcMs,
  utcMsToIsoWithOffset,
  weekdayOfDate,
  windowToUtcInterval,
} from './slot-grid.util.js';

describe('slot-grid.util', () => {
  describe('isValidTimezone', () => {
    it('accepts IANA zones', () => {
      expect(isValidTimezone('America/Mexico_City')).toBe(true);
      expect(isValidTimezone('Europe/Madrid')).toBe(true);
      expect(isValidTimezone('UTC')).toBe(true);
    });
    it('rejects garbage', () => {
      expect(isValidTimezone('Invalid/Zone')).toBe(false);
      expect(isValidTimezone('')).toBe(false);
    });
  });

  describe('weekdayOfDate', () => {
    it('returns the local weekday', () => {
      // 2026-04-20 is a Monday
      expect(weekdayOfDate('2026-04-20', 'America/Mexico_City')).toBe('MONDAY');
      expect(weekdayOfDate('2026-04-26', 'America/Mexico_City')).toBe('SUNDAY');
    });
  });

  describe('localHHMMToUtcMs', () => {
    it('converts a plain wall-clock time', () => {
      // CDMX = UTC-6 year round. 09:00 local → 15:00 UTC.
      const ms = localHHMMToUtcMs('2026-04-20', '09:00', 'America/Mexico_City');
      expect(new Date(ms!).toISOString()).toBe('2026-04-20T15:00:00.000Z');
    });

    it('honours UTC zone', () => {
      const ms = localHHMMToUtcMs('2026-04-20', '09:00', 'UTC');
      expect(new Date(ms!).toISOString()).toBe('2026-04-20T09:00:00.000Z');
    });

    it('returns null on malformed HH:MM', () => {
      expect(localHHMMToUtcMs('2026-04-20', 'abc', 'UTC')).toBeNull();
      expect(localHHMMToUtcMs('2026-04-20', '', 'UTC')).toBeNull();
    });

    it('returns null on DST spring-forward gap', () => {
      // US/EU spring forward on 2026-03-08 in America/New_York: 02:00→03:00.
      // 02:30 does not exist that day.
      const ms = localHHMMToUtcMs(
        '2026-03-08',
        '02:30',
        'America/New_York',
      );
      expect(ms).toBeNull();
    });

    it('resolves DST fall-back ambiguous hour deterministically', () => {
      // US/Canada DST ends 2026-11-01; 01:30 occurs twice in New York.
      // Luxon default is the earlier offset (EDT, UTC-4) → 01:30 EDT = 05:30 UTC.
      // We accept whichever offset Luxon picks as long as it is stable
      // (both instants are valid wall-clock 01:30 local).
      const ms = localHHMMToUtcMs('2026-11-01', '01:30', 'America/New_York');
      expect(ms).not.toBeNull();
      expect(new Date(ms!).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    });

    it('handles different DST rules (Europe/Madrid March)', () => {
      // Madrid spring forward 2026-03-29: 02:00→03:00.
      expect(
        localHHMMToUtcMs('2026-03-29', '02:30', 'Europe/Madrid'),
      ).toBeNull();
    });
  });

  describe('windowToUtcInterval', () => {
    it('builds an interval', () => {
      const w = windowToUtcInterval(
        '2026-04-20',
        '09:00',
        '18:00',
        'America/Mexico_City',
      );
      expect(w).toEqual({
        start: Date.parse('2026-04-20T15:00:00Z'),
        end: Date.parse('2026-04-21T00:00:00Z'),
      });
    });
    it('returns null when start is in a DST gap', () => {
      expect(
        windowToUtcInterval('2026-03-08', '02:00', '04:00', 'America/New_York'),
      ).toBeNull();
    });
    it('returns null when end <= start (cross-midnight deferred)', () => {
      expect(
        windowToUtcInterval('2026-04-20', '20:00', '02:00', 'America/Mexico_City'),
      ).toBeNull();
    });
    it('returns null when end === start', () => {
      expect(
        windowToUtcInterval('2026-04-20', '10:00', '10:00', 'UTC'),
      ).toBeNull();
    });
  });

  describe('enumerateDates', () => {
    it('returns single date for same-day range', () => {
      expect(enumerateDates('2026-04-20', '2026-04-20', 'UTC')).toEqual([
        '2026-04-20',
      ]);
    });
    it('includes both endpoints (inclusive range)', () => {
      expect(enumerateDates('2026-04-20', '2026-04-22', 'UTC')).toEqual([
        '2026-04-20',
        '2026-04-21',
        '2026-04-22',
      ]);
    });
    it('returns empty when from > to', () => {
      expect(enumerateDates('2026-04-25', '2026-04-20', 'UTC')).toEqual([]);
    });
    it('handles month boundaries', () => {
      expect(enumerateDates('2026-04-30', '2026-05-02', 'UTC')).toEqual([
        '2026-04-30',
        '2026-05-01',
        '2026-05-02',
      ]);
    });
    it('handles leap-year day', () => {
      expect(enumerateDates('2028-02-28', '2028-03-01', 'UTC')).toEqual([
        '2028-02-28',
        '2028-02-29',
        '2028-03-01',
      ]);
    });
  });

  describe('utcMsToIsoWithOffset', () => {
    it('emits with timezone offset', () => {
      const ms = Date.parse('2026-04-20T15:00:00Z');
      expect(utcMsToIsoWithOffset(ms, 'America/Mexico_City')).toBe(
        '2026-04-20T09:00:00-06:00',
      );
    });
    it('uses UTC when asked', () => {
      const ms = Date.parse('2026-04-20T15:00:00Z');
      expect(utcMsToIsoWithOffset(ms, 'UTC')).toBe('2026-04-20T15:00:00Z');
    });
    it('reflects DST offset in Madrid', () => {
      // April = Madrid summer time, UTC+2.
      const ms = Date.parse('2026-04-20T15:00:00Z');
      expect(utcMsToIsoWithOffset(ms, 'Europe/Madrid')).toBe(
        '2026-04-20T17:00:00+02:00',
      );
    });
  });
});
