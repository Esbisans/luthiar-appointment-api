import { Module } from '@nestjs/common';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullModule } from '@nestjs/bullmq';
import { QueueName } from './queue-names.js';

/**
 * Bull Board UI at /admin/queues.
 *
 * The /admin/* path is protected by the global AuthGuard + RolesGuard
 * (see the @Roles([UserRole.OWNER]) decorator in the controller binding
 * on main.ts). Unauthenticated requests fall through to our standard
 * 401 error shape.
 *
 * Route is intentionally NOT public. If you ever need to expose it to a
 * platform-admin role, grep for `@Roles` and adjust.
 */
@Module({
  imports: [
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature(
      { name: QueueName.Notifications, adapter: BullMQAdapter },
      { name: QueueName.Payments, adapter: BullMQAdapter },
      { name: QueueName.Dashboard, adapter: BullMQAdapter },
      { name: QueueName.Outbox, adapter: BullMQAdapter },
    ),
    BullModule.registerQueue(
      { name: QueueName.Notifications },
      { name: QueueName.Payments },
      { name: QueueName.Dashboard },
      { name: QueueName.Outbox },
    ),
  ],
})
export class QueuesBullBoardModule {}
