import {
  computeAvailability,
  computeNextSlots,
  type EngineContext,
} from './availability.engine.js';

// ── Fixture helpers ───────────────────────────────────────────────────

const TZ = 'America/Mexico_City';

/** 2026-04-15 12:00 UTC — a fixed "now" so cancellation math is deterministic. */
const NOW_MS = Date.parse('2026-04-15T12:00:00Z');

function utc(iso: string): number {
  return Date.parse(iso);
}

function baseContext(overrides?: Partial<EngineContext>): EngineContext {
  return {
    timezone: TZ,
    business: { cancellationHours: 24 },
    service: {
      id: 'svc-1',
      durationMin: 60,
      slotIntervalMin: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
    },
    businessHours: [
      // Mon–Fri 09-14 + 16-20, Sat 10-14, Sun closed.
      ...(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const).flatMap(
        (d) => [
          { dayOfWeek: d, startTime: '09:00', endTime: '14:00', isOpen: true },
          { dayOfWeek: d, startTime: '16:00', endTime: '20:00', isOpen: true },
        ],
      ),
      { dayOfWeek: 'SATURDAY', startTime: '10:00', endTime: '14:00', isOpen: true },
    ],
    staff: [
      {
        id: 'staff-A',
        isActive: true,
        customDuration: null,
        availabilities: (
          ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const
        ).map((d) => ({
          dayOfWeek: d,
          startTime: '09:00',
          endTime: '18:00',
          isActive: true,
        })),
      },
    ],
    blockedTimes: [],
    holidays: [],
    appointments: [],
    nowMs: NOW_MS,
    ...overrides,
  };
}

const DEFAULT_PARAMS = {
  fromISO: '2026-04-20', // Monday
  toISO: '2026-04-26', // Sunday
  granularityMin: 30,
  format: 'time' as const,
  outputTimezone: TZ,
};

// ── Tests ─────────────────────────────────────────────────────────────

describe('availability.engine — happy path', () => {
  it('returns one DaySlots per day in range', () => {
    const ctx = baseContext();
    const res = computeAvailability(ctx, DEFAULT_PARAMS);
    expect(Object.keys(res.days).sort()).toEqual([
      '2026-04-20',
      '2026-04-21',
      '2026-04-22',
      '2026-04-23',
      '2026-04-24',
      '2026-04-25',
      '2026-04-26',
    ]);
  });

  it('Sunday is closed (no business hours)', () => {
    const ctx = baseContext();
    const res = computeAvailability(ctx, DEFAULT_PARAMS);
    expect(res.days['2026-04-26']!.status).toBe('closed');
    expect(res.days['2026-04-26']!.slots).toHaveLength(0);
  });

  it('weekday produces non-zero slots with any-staff filter off', () => {
    const ctx = baseContext();
    const res = computeAvailability(ctx, DEFAULT_PARAMS);
    const mon = res.days['2026-04-20']!;
    expect(mon.status).toBe('open');
    expect(mon.slots.length).toBeGreaterThan(0);
    expect(mon.slots[0]!.staffIds).toContain('staff-A');
  });

  it('respects granularity', () => {
    const ctx = baseContext();
    const res60 = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      granularityMin: 60,
    });
    const res30 = computeAvailability(ctx, DEFAULT_PARAMS);
    expect(res30.days['2026-04-20']!.slots.length).toBeGreaterThan(
      res60.days['2026-04-20']!.slots.length,
    );
  });

  it('format=range includes end', () => {
    const ctx = baseContext();
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      format: 'range',
    });
    const firstSlot = res.days['2026-04-20']!.slots[0]!;
    expect(firstSlot.end).toBeDefined();
    expect(firstSlot.end).not.toBe(firstSlot.start);
  });
});

describe('availability.engine — multi-window business hours (lunch break)', () => {
  it('does not emit slots during the lunch gap (14-16)', () => {
    const ctx = baseContext();
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      granularityMin: 30,
    });
    const mon = res.days['2026-04-20']!.slots;
    // No slot should start between 14:00 and 16:00 local.
    const lunchSlots = mon.filter((s) => {
      const local = s.start.slice(11, 16); // HH:MM
      return local >= '14:00' && local < '16:00';
    });
    expect(lunchSlots).toHaveLength(0);
  });

  it('emits slots in both windows', () => {
    const ctx = baseContext();
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      granularityMin: 60,
    });
    const mon = res.days['2026-04-20']!.slots.map((s) => s.start.slice(11, 16));
    expect(mon).toContain('09:00');
    expect(mon).toContain('16:00');
  });
});

describe('availability.engine — staff availability limit', () => {
  it('staff ending at 18:00 caps afternoon slots', () => {
    const ctx = baseContext();
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      granularityMin: 60,
    });
    const afternoon = res.days['2026-04-20']!.slots
      .map((s) => s.start.slice(11, 16))
      .filter((t) => t >= '16:00');
    // 16:00 and 17:00 can finish by 18:00 (staff end). 18:00 and 19:00 cannot.
    expect(afternoon).toEqual(['16:00', '17:00']);
  });
});

describe('availability.engine — holidays', () => {
  it('exact-date holiday closes the day', () => {
    const ctx = baseContext({
      holidays: [{ dateISO: '2026-04-20', isRecurring: false }],
    });
    const res = computeAvailability(ctx, DEFAULT_PARAMS);
    expect(res.days['2026-04-20']!.status).toBe('holiday');
    expect(res.days['2026-04-20']!.slots).toHaveLength(0);
  });

  it('recurring holiday matches by MM-DD across years', () => {
    const ctx = baseContext({
      holidays: [{ dateISO: '2024-04-20', isRecurring: true }],
    });
    const res = computeAvailability(ctx, DEFAULT_PARAMS);
    expect(res.days['2026-04-20']!.status).toBe('holiday');
  });

  it('non-recurring holiday from a different year has no effect', () => {
    const ctx = baseContext({
      holidays: [{ dateISO: '2024-04-20', isRecurring: false }],
    });
    const res = computeAvailability(ctx, DEFAULT_PARAMS);
    expect(res.days['2026-04-20']!.status).toBe('open');
  });
});

describe('availability.engine — blocked times', () => {
  it('staff-specific block removes overlapping slots for that staff', () => {
    // Block 10:00-12:00 CDMX = 16:00-18:00 UTC on Monday.
    const ctx = baseContext({
      blockedTimes: [
        {
          staffId: 'staff-A',
          startUtcMs: utc('2026-04-20T16:00:00Z'),
          endUtcMs: utc('2026-04-20T18:00:00Z'),
        },
      ],
    });
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      granularityMin: 60,
    });
    const slots = res.days['2026-04-20']!.slots.map((s) => s.start.slice(11, 16));
    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('11:00');
    expect(slots).toContain('09:00');
    expect(slots).toContain('12:00');
  });

  it('business-wide block (staffId=null) applies to every staff', () => {
    const ctx = baseContext({
      staff: [
        ...baseContext().staff,
        {
          id: 'staff-B',
          isActive: true,
          customDuration: null,
          availabilities: (
            ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const
          ).map((d) => ({
            dayOfWeek: d,
            startTime: '09:00',
            endTime: '18:00',
            isActive: true,
          })),
        },
      ],
      blockedTimes: [
        {
          staffId: null,
          startUtcMs: utc('2026-04-20T16:00:00Z'), // 10:00 CDMX
          endUtcMs: utc('2026-04-20T18:00:00Z'), // 12:00 CDMX
        },
      ],
    });
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      granularityMin: 60,
    });
    const slot10 = res.days['2026-04-20']!.slots.find((s) =>
      s.start.includes('T10:00'),
    );
    expect(slot10).toBeUndefined();
  });
});

describe('availability.engine — existing appointments', () => {
  it('an appointment consumes the slot', () => {
    const ctx = baseContext({
      appointments: [
        {
          staffId: 'staff-A',
          startUtcMs: utc('2026-04-20T16:00:00Z'), // 10:00 CDMX
          endUtcMs: utc('2026-04-20T17:00:00Z'), // 11:00 CDMX
          bufferBeforeMin: 0,
          bufferAfterMin: 0,
        },
      ],
    });
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      granularityMin: 60,
    });
    const slots = res.days['2026-04-20']!.slots.map((s) => s.start.slice(11, 16));
    expect(slots).not.toContain('10:00');
  });

  it('appointment buffer extends the blocked range (half-open)', () => {
    // Buffer semantics: a 30-minute bufferAfter blocks the half-open range
    // [appointment.end, appointment.end + 30min). The slot starting exactly
    // at appointment.end + 30min is the first free one.
    const ctx = baseContext({
      appointments: [
        {
          staffId: 'staff-A',
          startUtcMs: utc('2026-04-20T16:00:00Z'), // 10:00 CDMX
          endUtcMs: utc('2026-04-20T17:00:00Z'), //   11:00 CDMX
          bufferBeforeMin: 0,
          bufferAfterMin: 30, // blocks [11:00, 11:30) CDMX
        },
      ],
    });
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      granularityMin: 30,
    });
    const slots = res.days['2026-04-20']!.slots.map((s) => s.start.slice(11, 16));
    expect(slots).not.toContain('10:00'); // during appointment
    expect(slots).not.toContain('10:30'); // during appointment
    expect(slots).not.toContain('11:00'); // inside buffer window
    expect(slots).toContain('11:30'); // first free moment after buffer
  });
});

describe('availability.engine — cancellation cutoff', () => {
  it('drops slots before cutoff, keeps slots after', () => {
    // nowMs = 2026-04-15 12:00 UTC.
    // With cancellationHours=48 → cutoff 2026-04-17 12:00 UTC.
    //   Thursday 2026-04-16 (09-14 CDMX = 15-20 UTC, 16-20 CDMX = 22-02 UTC+1)
    //     → all starts are before 2026-04-17 12:00 UTC → all dropped.
    //   Friday 2026-04-17 09:00 CDMX = 15:00 UTC → after cutoff → kept.
    const ctx = baseContext({ business: { cancellationHours: 48 } });
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      fromISO: '2026-04-16',
      toISO: '2026-04-17',
      granularityMin: 60,
    });
    expect(res.days['2026-04-16']!.slots).toHaveLength(0);
    expect(res.days['2026-04-17']!.slots.length).toBeGreaterThan(0);
  });
});

describe('availability.engine — customDuration per staff', () => {
  it('staff with longer customDuration needs more room in the window', () => {
    const ctx = baseContext({
      service: {
        id: 'svc-1',
        durationMin: 30,
        slotIntervalMin: 30,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
      },
      staff: [
        {
          ...baseContext().staff[0]!,
          customDuration: 120, // this staff takes 2h for this service
        },
      ],
    });
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      granularityMin: 60,
    });
    const slots = res.days['2026-04-20']!.slots.map((s) => s.start.slice(11, 16));
    // Morning 09-14: last start that fits 120min is 12:00. So 09,10,11,12 open,
    // but 13 blocked (13+2h = 15 crosses lunch gap 14-16).
    expect(slots).toContain('12:00');
    expect(slots).not.toContain('13:00');
  });
});

describe('availability.engine — any-staff aggregation', () => {
  it('slot is open if ANY staff can take it', () => {
    const ctx = baseContext({
      staff: [
        {
          id: 'staff-A',
          isActive: true,
          customDuration: null,
          availabilities: [
            {
              dayOfWeek: 'MONDAY',
              startTime: '09:00',
              endTime: '12:00',
              isActive: true,
            },
          ],
        },
        {
          id: 'staff-B',
          isActive: true,
          customDuration: null,
          availabilities: [
            {
              dayOfWeek: 'MONDAY',
              startTime: '13:00',
              endTime: '18:00',
              isActive: true,
            },
          ],
        },
      ],
    });
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      granularityMin: 60,
    });
    const morning = res.days['2026-04-20']!.slots.find((s) =>
      s.start.includes('T10:00'),
    );
    const afternoon = res.days['2026-04-20']!.slots.find((s) =>
      s.start.includes('T13:00'),
    );
    expect(morning?.staffIds).toEqual(['staff-A']);
    expect(afternoon?.staffIds).toEqual(['staff-B']);
  });
});

describe('availability.engine — staffIdFilter', () => {
  it('restricts output to the filtered staff', () => {
    const ctx = baseContext({
      staff: [
        {
          id: 'staff-A',
          isActive: true,
          customDuration: null,
          availabilities: [
            {
              dayOfWeek: 'MONDAY',
              startTime: '09:00',
              endTime: '18:00',
              isActive: true,
            },
          ],
        },
        {
          id: 'staff-B',
          isActive: true,
          customDuration: null,
          availabilities: [
            {
              dayOfWeek: 'MONDAY',
              startTime: '09:00',
              endTime: '18:00',
              isActive: true,
            },
          ],
        },
      ],
    });
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      staffIdFilter: 'staff-A',
    });
    for (const slot of res.days['2026-04-20']!.slots) {
      expect(slot.staffIds).toEqual(['staff-A']);
    }
  });
});

describe('availability.engine — DST day', () => {
  it('drops the skipped hour on spring forward (New York, 2026-03-08)', () => {
    const ctx = baseContext({
      timezone: 'America/New_York',
      businessHours: [
        {
          dayOfWeek: 'SUNDAY',
          startTime: '01:00',
          endTime: '05:00',
          isOpen: true,
        },
      ],
      staff: [
        {
          id: 'staff-A',
          isActive: true,
          customDuration: null,
          availabilities: [
            {
              dayOfWeek: 'SUNDAY',
              startTime: '01:00',
              endTime: '05:00',
              isActive: true,
            },
          ],
        },
      ],
      business: { cancellationHours: 0 },
      nowMs: Date.parse('2026-03-01T00:00:00Z'),
    });
    const res = computeAvailability(ctx, {
      fromISO: '2026-03-08',
      toISO: '2026-03-08',
      granularityMin: 30,
      format: 'time',
      outputTimezone: 'America/New_York',
    });
    const slots = res.days['2026-03-08']!.slots.map((s) => s.start.slice(11, 16));
    // 02:00 and 02:30 do NOT exist; 03:00 onward do.
    expect(slots).not.toContain('02:00');
    expect(slots).not.toContain('02:30');
    expect(slots).toContain('03:00');
  });
});

describe('availability.engine — past dates', () => {
  it('marks past dates as past', () => {
    const ctx = baseContext();
    const res = computeAvailability(ctx, {
      ...DEFAULT_PARAMS,
      fromISO: '2026-04-01',
      toISO: '2026-04-01',
    });
    expect(res.days['2026-04-01']!.status).toBe('past');
  });
});

describe('computeNextSlots', () => {
  it('returns up to `limit` future slots in order', () => {
    const ctx = baseContext();
    const res = computeNextSlots(ctx, '2026-04-16', '2026-04-25', {
      limit: 3,
      outputTimezone: TZ,
    });
    expect(res.slots).toHaveLength(3);
    const starts = res.slots.map((s) => s.start);
    expect(starts).toEqual([...starts].sort());
  });

  it('honours staffIdFilter', () => {
    const ctx = baseContext({
      staff: [
        ...baseContext().staff,
        {
          id: 'staff-B',
          isActive: true,
          customDuration: null,
          availabilities: baseContext().staff[0]!.availabilities,
        },
      ],
    });
    const res = computeNextSlots(ctx, '2026-04-16', '2026-04-25', {
      limit: 1,
      staffIdFilter: 'staff-B',
      outputTimezone: TZ,
    });
    expect(res.slots[0]!.staffIds).toEqual(['staff-B']);
  });
});
