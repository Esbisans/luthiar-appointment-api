import { AppointmentStatus } from '../../generated/prisma/enums.js';
import {
  assertCanTransition,
  canTransition,
  isActiveStatus,
  TRANSITIONS,
} from './appointment-state.js';

describe('appointment-state', () => {
  describe('canTransition', () => {
    it.each([
      [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, true],
      [AppointmentStatus.PENDING, AppointmentStatus.CANCELLED, true],
      [AppointmentStatus.PENDING, AppointmentStatus.NO_SHOW, true],
      [AppointmentStatus.PENDING, AppointmentStatus.IN_PROGRESS, false],
      [AppointmentStatus.PENDING, AppointmentStatus.COMPLETED, false],

      [AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS, true],
      [AppointmentStatus.CONFIRMED, AppointmentStatus.CANCELLED, true],
      [AppointmentStatus.CONFIRMED, AppointmentStatus.NO_SHOW, true],
      [AppointmentStatus.CONFIRMED, AppointmentStatus.COMPLETED, false],
      [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING, false],

      [AppointmentStatus.IN_PROGRESS, AppointmentStatus.COMPLETED, true],
      [AppointmentStatus.IN_PROGRESS, AppointmentStatus.CANCELLED, true],
      [AppointmentStatus.IN_PROGRESS, AppointmentStatus.NO_SHOW, false],
      [AppointmentStatus.IN_PROGRESS, AppointmentStatus.PENDING, false],

      // Terminal states
      [AppointmentStatus.COMPLETED, AppointmentStatus.CANCELLED, false],
      [AppointmentStatus.CANCELLED, AppointmentStatus.PENDING, false],
      [AppointmentStatus.NO_SHOW, AppointmentStatus.CONFIRMED, false],
    ])('%s → %s should be %s', (from, to, expected) => {
      expect(canTransition(from, to)).toBe(expected);
    });

    it('returns false for same-status "transition" (no self-loop)', () => {
      expect(canTransition(AppointmentStatus.PENDING, AppointmentStatus.PENDING))
        .toBe(false);
    });
  });

  describe('assertCanTransition', () => {
    it('throws ConflictError with from/to/allowedFrom details', () => {
      expect(() =>
        assertCanTransition(
          AppointmentStatus.COMPLETED,
          AppointmentStatus.CONFIRMED,
        ),
      ).toThrow(/Invalid status transition COMPLETED → CONFIRMED/);
    });

    it('is a no-op on valid transition', () => {
      expect(() =>
        assertCanTransition(
          AppointmentStatus.PENDING,
          AppointmentStatus.CONFIRMED,
        ),
      ).not.toThrow();
    });
  });

  describe('isActiveStatus', () => {
    it('flags PENDING/CONFIRMED/IN_PROGRESS as active', () => {
      expect(isActiveStatus(AppointmentStatus.PENDING)).toBe(true);
      expect(isActiveStatus(AppointmentStatus.CONFIRMED)).toBe(true);
      expect(isActiveStatus(AppointmentStatus.IN_PROGRESS)).toBe(true);
    });
    it('flags terminals as inactive', () => {
      expect(isActiveStatus(AppointmentStatus.COMPLETED)).toBe(false);
      expect(isActiveStatus(AppointmentStatus.CANCELLED)).toBe(false);
      expect(isActiveStatus(AppointmentStatus.NO_SHOW)).toBe(false);
    });
  });

  describe('TRANSITIONS table', () => {
    it('has an entry for every enum value', () => {
      for (const status of Object.values(AppointmentStatus)) {
        expect(TRANSITIONS[status]).toBeDefined();
      }
    });
    it('terminal states have no outgoing transitions', () => {
      expect(TRANSITIONS[AppointmentStatus.COMPLETED]).toEqual([]);
      expect(TRANSITIONS[AppointmentStatus.CANCELLED]).toEqual([]);
      expect(TRANSITIONS[AppointmentStatus.NO_SHOW]).toEqual([]);
    });
  });
});
