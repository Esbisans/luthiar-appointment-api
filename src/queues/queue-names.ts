/**
 * Logical queues (not one per job type — kept small to avoid excess Redis
 * connections). Each queue groups jobs with similar SLO/retry profile.
 */
export const QueueName = {
  /** send-confirmation, send-reminder-24h/1h, send-followup, retry-failed */
  Notifications: 'notifications',
  /** Stripe webhook processing */
  Payments: 'payments',
  /** WebSocket pushes to dashboards (Fase 4) */
  Dashboard: 'dashboard',
  /** Outbox retry (repeatable cron) */
  Outbox: 'outbox',
} as const;

export type QueueNameValue = (typeof QueueName)[keyof typeof QueueName];

export const QUEUE_NAMES: QueueNameValue[] = Object.values(QueueName);
