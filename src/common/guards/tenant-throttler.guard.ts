import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { ClsServiceManager } from 'nestjs-cls';
import { RateLimitError } from '../errors/index.js';

/**
 * Multi-tier rate-limit guard.
 *
 * Two named throttlers configured in `app.module.ts`:
 *   • `global-ip`  — per-IP floor: protects against generic DoS regardless
 *                    of authentication. Tracker = IP.
 *   • `tenant`     — per-API-key budget: stops one misbehaving agent from
 *                    monopolising the API. Tracker = `apikey:<id>` for
 *                    API-key callers, falls back to `ip:<ip>` for JWT.
 *
 * Why a custom tracker: the default `req.ip` tracker collapses every
 * agent into one bucket because LiveKit Cloud workers share egress IPs.
 * Tracking by API-key keeps tenants isolated from each other.
 *
 * Storage: Redis (`@nest-lab/throttler-storage-redis`) — replicas share
 * the same counter via Lua-atomic `EVAL` so the limit is consistent across
 * pods. The library handles connection pooling internally.
 */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    try {
      const cls = ClsServiceManager.getClsService();
      const apiKeyId = cls.get<string>('apiKeyId');
      if (apiKeyId) return `apikey:${apiKeyId}`;
    } catch {
      /* CLS not active (boot phase / health checks) — fall through */
    }
    const ip = (req as { ip?: string }).ip ?? 'unknown';
    return `ip:${ip}`;
  }

  /**
   * Translate the framework's default `ThrottlerException` into our
   * RFC 9457 `RateLimitError`. Adds `RateLimit-*` (RFC draft) and
   * legacy `X-RateLimit-*` headers so clients (Stripe-style) can adapt.
   */
  protected async throwThrottlingException(
    context: import('@nestjs/common').ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const res = context.switchToHttp().getResponse<{
      setHeader: (k: string, v: string) => void;
    }>();
    const resetSec = Math.max(1, Math.ceil(detail.timeToBlockExpire));
    res.setHeader('Retry-After', String(resetSec));
    res.setHeader('X-RateLimit-Limit', String(detail.limit));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('X-RateLimit-Reset', String(resetSec));
    res.setHeader(
      'RateLimit',
      `limit=${detail.limit}, remaining=0, reset=${resetSec}`,
    );
    res.setHeader(
      'RateLimit-Policy',
      `${detail.limit};w=${Math.ceil(detail.ttl / 1000)};name="${detail.key}"`,
    );
    throw new RateLimitError(
      `Rate limit exceeded for ${detail.key}`,
      {
        throttler: detail.key,
        limit: detail.limit,
        retryAfterSeconds: resetSec,
      },
    );
  }
}
