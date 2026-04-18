/**
 * Event type constants + payload shapes for Appointment side-effects.
 * Emitted by the OutboxService after the transaction commits.
 */

export const AppointmentEvents = {
  Created: 'appointment.created',
  Confirmed: 'appointment.confirmed',
  Cancelled: 'appointment.cancelled',
  Rescheduled: 'appointment.rescheduled',
  CheckedIn: 'appointment.checked_in',
  Completed: 'appointment.completed',
  NoShow: 'appointment.no_show',
} as const;

export type AppointmentEvent = (typeof AppointmentEvents)[keyof typeof AppointmentEvents];

export interface AppointmentEventPayload {
  appointmentId: string;
  businessId: string;
  customerId: string;
  staffId: string;
  serviceId: string;
  startTime: string;
  channel: string;
  // Optional extras
  fromStatus?: string;
  toStatus?: string;
  cancellationReason?: string;
  rescheduledFromId?: string;
  rescheduledToId?: string;
}
