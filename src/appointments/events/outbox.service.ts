import { Injectable } from '@nestjs/common';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import { ClsService } from 'nestjs-cls';
import { ulid } from 'ulid';
import * as Sentry from '@sentry/nestjs';
import { PrismaService } from '../../prisma/prisma.service.js';
import { QueueProducer } from '../../queues/producers/queue.producer.js';
import { QueueName, QueueNameValue } from '../../queues/queue-names.js';
import { registerAfterCommit } from '../../common/transaction/after-commit.js';
import { OutboxPrismaClient } from './outbox-prisma.client.js';

/**
 * Shape of an event type: a dotted lowercase string like
 * `appointment.created`, `customer.updated`, `payment.succeeded`.
 * The DashboardProcessor translates dots to colons for client
 * Socket.io convention (`appointment:created`).
 */
export type OutboxEventType = string;

/** Payloads are opaque to the outbox — shape is caller's responsibility. */
export type OutboxEventPayload = Record<string, unknown>;

/**
 * Transactional outbox bridged to BullMQ.
 *
 * Write path (inside the request tx):
 *   `enqueue(type, payload)` → INSERT OutboxEvent row (PENDING) via main
 *   PrismaService (tenant-scoped, same tx as the appointment).
 *
 * Publish path (AFTER `$transaction` commits):
 *   `flushPending()` → uses `OutboxPrismaClient` (connects as
 *   `outbox_worker` Postgres role — has an explicit USING(true) policy
 *   on OutboxEvent, NOBYPASSRLS, scoped grants). SELECT FOR UPDATE SKIP
 *   LOCKED → queue.add() → UPDATE status=PROCESSED.
 *
 * kickFlush():
 *   Fire-and-forget wrapper. Called inline from appointment mutations to
 *   reduce latency. Captures CLS values BEFORE the `setImmediate` callback
 *   so Pino / Sentry have context if the flush fails. Errors are logged +
 *   Sentry-captured but NOT propagated to the response — the cron picks
 *   up stuck rows every 30s as a safety net.
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outboxPrisma: OutboxPrismaClient,
    private readonly cls: ClsService,
    private readonly queues: QueueProducer,
    @InjectPinoLogger(OutboxService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Write path (inside request tx) ────────────────────────────────

  async enqueue(
    type: OutboxEventType,
    payload: OutboxEventPayload,
  ): Promise<string> {
    const id = ulid();
    await (
      this.prisma.db as unknown as {
        outboxEvent: { create: (args: { data: unknown }) => Promise<unknown> };
      }
    ).outboxEvent.create({
      data: {
        id,
        type,
        payload: payload as unknown as Record<string, unknown>,
        status: 'PENDING',
      } as never,
    });
    return id;
  }

  // ── Kick (fire-and-forget with full observability) ────────────────

  /**
   * Register a flush to run after the current request's tx commits.
   *
   * We can't flush synchronously here because `enqueue` writes the outbox
   * row inside the tenant transaction — until that tx commits, a separate
   * connection (the outbox_worker role) cannot see the row due to MVCC
   * isolation.
   *
   * The generic `registerAfterCommit` helper pushes our callback onto a
   * CLS-stored list that `TenantTxInterceptor` drains after the
   * `$transaction` Promise resolves. The 30s cron stays as a safety net.
   */
  kickFlush(): void {
    // Capture CLS values NOW so the hook closure still has them when it
    // runs post-commit (the CLS store itself is still active, but capturing
    // makes the log/Sentry output explicit).
    const traceId = this.safeCls('traceId');
    const businessId = this.safeCls('businessId');
    registerAfterCommit(this.cls, () => {
      this.flushPending().catch((err: unknown) => {
        this.logger.error(
          { err, traceId, businessId, evt: 'outbox.kick.failed' },
          'post-commit flush failed — cron will retry',
        );
        Sentry.captureException(err, {
          tags: {
            component: 'outbox-kick',
            businessId: businessId ?? 'unknown',
          },
          extra: { traceId },
        });
      });
    });
  }

  // ── Flush path (via dedicated outbox_worker role) ─────────────────

  /**
   * Scans PENDING outbox rows cross-tenant via the `outbox_worker`
   * Postgres role (not the main app role). For each row, sets CLS
   * businessId temporarily so the BullMQ producer wraps the job with
   * the correct `_ctx` for the worker's CLS rehydration.
   */
  async flushPending(): Promise<void> {
    const rows = await this.outboxPrisma.$queryRaw<
      {
        id: string;
        businessId: string;
        type: OutboxEventType;
        payload: OutboxEventPayload;
      }[]
    >`
      SELECT "id", "businessId", "type", "payload"
      FROM "OutboxEvent"
      WHERE "status" = 'PENDING'
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `;

    for (const row of rows) {
      try {
        const queues = this.routeToQueues(row.type);
        await this.cls.runWith({}, async () => {
          this.cls.set('businessId', row.businessId);
          this.cls.set('traceId', row.id);
          // Fan-out: each outbox row can feed multiple queues
          // (e.g. Notifications AND Dashboard for appointment.*). Jobs
          // are keyed per-queue so replays stay idempotent per consumer.
          await Promise.all(
            queues.map((queue: QueueNameValue) =>
              this.queues.enqueue(
                queue,
                row.type,
                row.payload as unknown as Record<string, unknown>,
                { jobId: `outbox-${queue}-${row.id}` },
              ),
            ),
          );
        });
        await this.markProcessed(row.id);
      } catch (err) {
        this.logger.error(
          { err, outboxId: row.id, type: row.type, businessId: row.businessId },
          'outbox.flush row failed',
        );
        await this.bumpAttempts(row.id);
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Event-type → queues routing. Returns an array because one event may
   * fan out to multiple consumers: appointment.* goes to Notifications
   * (email/WhatsApp/SMS side-effects) AND Dashboard (Socket.io push to
   * connected clients).
   */
  private routeToQueues(type: OutboxEventType): QueueNameValue[] {
    if (type.startsWith('appointment.')) {
      return [QueueName.Notifications, QueueName.Dashboard];
    }
    if (type.startsWith('payment.')) {
      return [QueueName.Payments, QueueName.Dashboard];
    }
    if (type.startsWith('customer.')) {
      // Customers: no external notification side-effect yet, only
      // dashboard push so the owner sees new/updated customers live.
      return [QueueName.Dashboard];
    }
    return [QueueName.Notifications];
  }

  private async markProcessed(id: string): Promise<void> {
    await this.outboxPrisma.$executeRaw`
      UPDATE "OutboxEvent"
      SET "status" = 'PROCESSED', "processedAt" = now()
      WHERE "id" = ${id}
    `;
  }

  private async bumpAttempts(id: string): Promise<void> {
    await this.outboxPrisma.$executeRaw`
      UPDATE "OutboxEvent"
      SET "attempts" = "attempts" + 1
      WHERE "id" = ${id}
    `;
  }

  private safeCls(key: string): string | undefined {
    try {
      return this.cls.get<string>(key);
    } catch {
      return undefined;
    }
  }
}
