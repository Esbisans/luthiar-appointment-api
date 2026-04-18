import { AppointmentStatus } from '../../generated/prisma/enums.js';
import { ConflictError } from '../../common/errors/index.js';

/**
 * Appointment state machine — pure, exhaustive, unit-testable.
 *
 * Rules:
 *   • Every transition listed explicitly → no implicit allowed moves.
 *   • Terminal states (COMPLETED, CANCELLED, NO_SHOW) have no outgoing edges.
 *   • Transitions are the ONLY way to change status — no `PATCH status`.
 *
 * Kept out of the Prisma layer so it is testable with zero DB, and so any
 * future channel (queue worker, chat bot, dashboard) gets the same rules.
 */

export const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  PENDING: [
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  CONFIRMED: [
    AppointmentStatus.IN_PROGRESS,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  IN_PROGRESS: [
    AppointmentStatus.COMPLETED,
    AppointmentStatus.CANCELLED,
  ],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export function canTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCanTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(
      `Invalid status transition ${from} → ${to}`,
      { from, to, allowedFrom: TRANSITIONS[from] },
    );
  }
}

/** True if an appointment in this status still occupies its slot. */
export function isActiveStatus(status: AppointmentStatus): boolean {
  return (
    status === AppointmentStatus.PENDING ||
    status === AppointmentStatus.CONFIRMED ||
    status === AppointmentStatus.IN_PROGRESS
  );
}
