import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthCheckResult } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator.js';
import { PrismaHealthIndicator } from './indicators/prisma.health.js';
import { RedisHealthIndicator } from './indicators/redis.health.js';

/**
 * Cache window for `/health/ready`. The endpoint is `@Public()` and fans out
 * to Postgres + Redis, so without a cache an unauthenticated caller rotating
 * IPs can amplify into the DB (the per-IP throttler is exempt via
 * `@SkipThrottle` below — without it K8s/LB probes would collide with real
 * traffic in the `global-ip` bucket). 5s caps DB load at ~12 queries/min/pod
 * regardless of external call rate, and leaves detection latency well inside
 * the typical K8s `failureThreshold=3 × periodSeconds=10 = 30s` drain window.
 */
const READY_CACHE_TTL_MS = 5_000;

/**
 * Two standard endpoints, matching the K8s liveness/readiness convention.
 *
 * `/health/live` — is the process responding? K8s restarts the container
 * if this fails. Must NOT check dependencies (a slow DB shouldn't
 * trigger a pod restart loop).
 *
 * `/health/ready` — are dependencies OK? K8s removes the pod from the
 * load balancer if this fails, but does NOT restart it. Safe to check
 * Postgres + Redis here.
 *
 * Both endpoints are @Public (no auth) because infra probes shouldn't
 * carry JWTs, and @SkipThrottle on both named throttlers so probes don't
 * collide with real-traffic buckets when the LB collapses x-forwarded-for.
 * Terminus returns stable `status: 'up'/'down'` strings — no IP, password,
 * or version info is leaked.
 */
@ApiTags('health')
@Controller('health')
@SkipThrottle({ 'global-ip': true, tenant: true })
export class HealthController {
  private readyCache: { at: number; result: HealthCheckResult } | null = null;

  constructor(
    private readonly health: HealthCheckService,
    private readonly db: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Public()
  @Get('live')
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness — the process is responding' })
  live() {
    return this.health.check([]);
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness — Postgres + Redis are reachable within 3s',
  })
  async ready(): Promise<HealthCheckResult> {
    const now = Date.now();
    if (this.readyCache && now - this.readyCache.at < READY_CACHE_TTL_MS) {
      return this.readyCache.result;
    }
    const result = await this.health.check([
      () => this.db.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
    ]);
    this.readyCache = { at: now, result };
    return result;
  }
}
