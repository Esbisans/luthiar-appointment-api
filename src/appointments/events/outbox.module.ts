import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service.js';
import { OutboxPrismaClient } from './outbox-prisma.client.js';

/**
 * Shared outbox plumbing. Marked `@Global` so any module (Customers,
 * future Payments, etc.) can inject `OutboxService` without importing
 * this module explicitly.
 *
 * File path remains under `appointments/events/` for historical reasons;
 * the service is generic (accepts any event type/payload).
 */
@Global()
@Module({
  providers: [OutboxService, OutboxPrismaClient],
  exports: [OutboxService, OutboxPrismaClient],
})
export class OutboxModule {}
