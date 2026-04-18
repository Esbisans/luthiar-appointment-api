/**
 * Outbox event types emitted by the CustomersModule. Consumed by
 * DashboardProcessor and pushed to `tenant:<businessId>` via Socket.io
 * as `customer:created` / `customer:updated`.
 *
 * No notification side-effects (WhatsApp/email) — just dashboard real-time.
 * See docs/deferred-work.md if that ever changes.
 */
export const CustomerEvents = {
  Created: 'customer.created',
  Updated: 'customer.updated',
} as const;

export type CustomerEvent = (typeof CustomerEvents)[keyof typeof CustomerEvents];

export interface CustomerEventPayload {
  customerId: string;
  businessId: string;
  name: string;
  phone: string;
  email?: string | null;
  /** Which API surface created the record (for agent-attribution). */
  source?: 'voice' | 'whatsapp' | 'web_chat' | 'dashboard' | 'api' | 'findOrCreate';
  [key: string]: unknown;
}
