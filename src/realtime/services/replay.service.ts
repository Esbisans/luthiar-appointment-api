import { Injectable } from '@nestjs/common';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import { OutboxPrismaClient } from '../../appointments/events/outbox-prisma.client.js';

interface ReplayRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Serves `events:sync` replays: when a client reconnects after a long
 * outage (past the 2-minute Connection State Recovery window), it sends
 * `{ since: <lastEventId> }` and we fetch every OutboxEvent more recent
 * than that for the tenant.
 *
 * Uses the outbox_worker Prisma client so it can scan cross-tenant. The
 * caller (gateway) must filter by `businessId` to prevent leaks.
 */
@Injectable()
export class ReplayService {
  constructor(
    private readonly outboxPrisma: OutboxPrismaClient,
    @InjectPinoLogger(ReplayService.name)
    private readonly logger: PinoLogger,
  ) {}

  async fetchSince(
    businessId: string,
    sinceId: string,
    limit: number,
  ): Promise<ReplayRow[]> {
    try {
      return await this.outboxPrisma.$queryRaw<ReplayRow[]>`
        SELECT "id", "type", "payload", "createdAt"
        FROM "OutboxEvent"
        WHERE "businessId" = ${businessId}
          AND "id" > ${sinceId}
          AND "status" = 'PROCESSED'
        ORDER BY "id" ASC
        LIMIT ${limit}
      `;
    } catch (err) {
      this.logger.error(
        { err, businessId, sinceId },
        'replay.fetch failed',
      );
      return [];
    }
  }
}
