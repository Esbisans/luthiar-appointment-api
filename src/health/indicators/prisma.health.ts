import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Pings Postgres with `SELECT 1` using the raw PrismaClient (not the
 * tenant-extended one — this runs in a public endpoint with no CLS ctx).
 * A 3-second timeout wrapper keeps an unhealthy DB from stalling K8s
 * readiness checks.
 */
@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  private static readonly TIMEOUT_MS = 3_000;

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const probe = (
        this.prisma as unknown as {
          $queryRawUnsafe: (sql: string) => Promise<unknown>;
        }
      ).$queryRawUnsafe('SELECT 1');
      await Promise.race([
        probe,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('postgres health check timed out')),
            PrismaHealthIndicator.TIMEOUT_MS,
          ),
        ),
      ]);
      return this.getStatus(key, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'postgres unreachable';
      throw new HealthCheckError('Postgres check failed', this.getStatus(key, false, { message }));
    }
  }
}
