import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueName } from '../../queues/queue-names.js';

/**
 * Pings Redis via the BullMQ client (which holds our only Redis
 * connection pool). `queue.client.ping()` returns 'PONG' when healthy.
 * 3-second timeout — same rationale as the Prisma indicator.
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  private static readonly TIMEOUT_MS = 3_000;

  constructor(
    @InjectQueue(QueueName.Notifications) private readonly queue: Queue,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const client = await this.queue.client;
      const probe = client.ping();
      const result = await Promise.race([
        probe,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('redis health check timed out')),
            RedisHealthIndicator.TIMEOUT_MS,
          ),
        ),
      ]);
      if (result !== 'PONG') {
        throw new Error(`unexpected redis reply: ${result}`);
      }
      return this.getStatus(key, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'redis unreachable';
      throw new HealthCheckError('Redis check failed', this.getStatus(key, false, { message }));
    }
  }
}
