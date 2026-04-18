import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Dedicated Prisma client for the outbox worker.
 *
 * Connects as the `outbox_worker` Postgres role which has:
 *   • NOBYPASSRLS (can't accidentally leak tenant data from other tables)
 *   • An explicit `FOR ALL TO outbox_worker USING (true)` policy ONLY on
 *     OutboxEvent — full cross-tenant visibility on that single table.
 *
 * This client is injected into `OutboxService.flushPending()` for the cron
 * path. The write path (`enqueue`) continues using the main `PrismaService`
 * inside the request tx.
 *
 * Connection pool is capped at 5 (via OUTBOX_DATABASE_URL query string) to
 * minimize the overhead of a second pool.
 */
@Injectable()
export class OutboxPrismaClient
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    const url = config.get<string>('OUTBOX_DATABASE_URL');
    super({
      adapter: new PrismaPg({
        connectionString: url,
        // Outbox work is short-lived by design: `SELECT FOR UPDATE SKIP
        // LOCKED LIMIT 50` + BullMQ enqueue. If anything blocks longer
        // than a handful of seconds, something is wrong (stuck lock,
        // Redis latency) — fail fast so the cron can retry on the next
        // tick rather than pile up.
        max: 5,
        statement_timeout: 5_000,
        idle_in_transaction_session_timeout: 10_000,
        lock_timeout: 2_000,
        connectionTimeoutMillis: 3_000,
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
