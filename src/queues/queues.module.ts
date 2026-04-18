import {
  Global,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Worker } from 'bullmq';
import { QueueName } from './queue-names.js';
import { QueueProducer } from './producers/queue.producer.js';
import { NotificationsProcessor } from './processors/notifications.processor.js';
import { PaymentsProcessor } from './processors/payments.processor.js';
import { DashboardProcessor } from './processors/dashboard.processor.js';
import { OutboxProcessor } from './processors/outbox.processor.js';

/**
 * Drain budget for in-flight BullMQ jobs on SIGTERM. Sized to fit
 * inside the K8s default `terminationGracePeriodSeconds: 30` with a
 * 5s safety margin so we have headroom for Nest's other shutdown
 * hooks (Prisma disconnect, HTTP server close, Sentry flush).
 *
 * If you bump K8s grace to 45s (recommended for queue workers, see
 * deferred-work D88), this can grow to 35-40s.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (cfg: ConfigService) => ({
        connection: {
          host: cfg.get<string>('REDIS_HOST', 'localhost'),
          port: cfg.get<number>('REDIS_PORT', 6379),
          db: cfg.get<number>('REDIS_DB_QUEUES', 1),
          // Required by BullMQ — see docs.bullmq.io/guide/going-to-production.
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: QueueName.Notifications },
      { name: QueueName.Payments },
      { name: QueueName.Dashboard },
      { name: QueueName.Outbox },
    ),
  ],
  providers: [
    QueueProducer,
    NotificationsProcessor,
    PaymentsProcessor,
    DashboardProcessor,
    OutboxProcessor,
  ],
  exports: [QueueProducer, BullModule],
})
export class QueuesModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly producer: QueueProducer,
    private readonly notifications: NotificationsProcessor,
    private readonly payments: PaymentsProcessor,
    private readonly dashboard: DashboardProcessor,
    private readonly outbox: OutboxProcessor,
    @InjectPinoLogger(QueuesModule.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Schedule the outbox safety-net cron once on boot. jobId is fixed so
   * repeatable registrations don't duplicate on redeploy.
   */
  async onModuleInit() {
    await this.producer.getQueue(QueueName.Outbox).add(
      'outbox-flush',
      {},
      {
        repeat: { pattern: '*/30 * * * * *' },
        jobId: 'outbox-flush-cron',
        removeOnComplete: true,
        removeOnFail: { age: 3600 },
      },
    );
  }

  /**
   * SIGTERM drain. `worker.close(false)` stops accepting new jobs and waits
   * for in-flight ones to finish; `true` forces immediate close. We race the
   * graceful close against a timeout — if we exceed budget we force-close so
   * the pod exits cleanly instead of getting SIGKILL'd mid-job.
   *
   * Processors must be idempotent: a force-closed job returns to the queue
   * and another worker (or this pod on restart) will re-run it. See D88.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    const workers = [this.notifications, this.payments, this.dashboard, this.outbox]
      .map((p) => (p as unknown as { worker?: Worker }).worker)
      .filter((w): w is Worker => Boolean(w));

    if (workers.length === 0) return;

    this.logger.info(
      { signal, count: workers.length, budgetMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
      'queue.shutdown.start',
    );
    const startedAt = Date.now();

    try {
      await Promise.race([
        Promise.all(workers.map((w) => w.close(false))),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('drain_timeout')),
            SHUTDOWN_DRAIN_TIMEOUT_MS,
          ),
        ),
      ]);
      this.logger.info(
        { count: workers.length, durationMs: Date.now() - startedAt },
        'queue.shutdown.graceful',
      );
    } catch (err) {
      this.logger.warn(
        {
          err,
          count: workers.length,
          durationMs: Date.now() - startedAt,
        },
        'queue.shutdown.timeout_force',
      );
      await Promise.allSettled(workers.map((w) => w.close(true)));
    }
  }
}
