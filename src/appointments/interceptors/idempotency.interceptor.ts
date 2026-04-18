import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { defer, from, Observable, of, switchMap } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ValidationError } from '../../common/errors/index.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const TTL_HOURS = 24;
const KEY_FORMAT = /^[A-Za-z0-9_\-:.]{8,200}$/;

/**
 * Stripe-style idempotency.
 *
 * • For API-key callers (voice / WhatsApp / chat) the header is required on
 *   POST /appointments and POST /appointments/:id/reschedule. Dashboard
 *   JWT callers may omit it.
 * • Body hash is stored so replays with a different body return 422 (the
 *   same error Stripe returns).
 * • `INSERT ... ON CONFLICT DO NOTHING` is race-safe: if two concurrent
 *   requests share the key, only one inserts. The loser re-reads the
 *   snapshot.
 *
 * Apply via `@UseInterceptors(IdempotencyInterceptor)` on the target route
 * handlers.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const key = (req.headers[IDEMPOTENCY_HEADER] as string | undefined) ?? '';
    const authType = this.cls.get<string>('authType');
    const apiKeyCall = authType === 'apikey';

    if (!key) {
      if (apiKeyCall) {
        return defer(() => {
          throw new ValidationError(
            'Idempotency-Key header is required for API-key calls',
            [{ field: 'Idempotency-Key', code: 'missing' }],
          );
        });
      }
      return next.handle();
    }
    if (!KEY_FORMAT.test(key)) {
      return defer(() => {
        throw new ValidationError(
          'Idempotency-Key must be 8-200 chars [A-Za-z0-9_-:.]',
          [{ field: 'Idempotency-Key', code: 'invalid_format' }],
        );
      });
    }

    const businessId = this.cls.get<string>('businessId');
    const requestHash = this.hashRequest(req);

    return defer(() =>
      from(this.lookupOrReserve(key, businessId, req.method, req.url, requestHash)),
    ).pipe(
      switchMap((outcome) => {
        if (outcome.kind === 'replay') {
          // Replay — return the stored response body with the stored status.
          const res = context.switchToHttp().getResponse<{ status: (n: number) => unknown }>();
          if (outcome.statusCode) res.status(outcome.statusCode);
          return of(outcome.responseBody);
        }
        if (outcome.kind === 'mismatch') {
          throw new ValidationError(
            'Idempotency-Key reused with a different request body',
            [{ field: 'Idempotency-Key', code: 'mismatch' }],
          );
        }
        // Await the snapshot write BEFORE returning so a rapid-fire replay
        // from the same caller sees the right status and replays cleanly.
        // Capture the actual response status — transitions return 200, create
        // returns 201; both must be replayed identically.
        return next.handle().pipe(
          switchMap(async (body: unknown) => {
            const res = context
              .switchToHttp()
              .getResponse<{ statusCode?: number }>();
            const statusCode = res.statusCode ?? 200;
            try {
              await this.recordResponse(key, statusCode, body);
            } catch {
              /* best effort — don't kill the response if we can't persist */
            }
            return body;
          }),
        );
      }),
    );
  }

  private hashRequest(req: Request): string {
    const body = JSON.stringify(req.body ?? {});
    return createHash('sha256')
      .update(`${req.method}|${req.url}|${body}`)
      .digest('hex');
  }

  private async lookupOrReserve(
    key: string,
    businessId: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<
    | { kind: 'new' }
    | { kind: 'replay'; statusCode: number | null; responseBody: unknown }
    | { kind: 'mismatch' }
  > {
    // Atomic reserve: INSERT ON CONFLICT DO NOTHING returns 0 rows if the
    // key exists → we know to re-read.
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);
    const inserted = await (
      this.prisma.db as unknown as {
        $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
      }
    ).$executeRaw`
      INSERT INTO "IdempotencyKey"
        ("key", "businessId", "method", "path", "requestHash", "expiresAt")
      VALUES
        (${key}, ${businessId}, ${method}, ${path}, ${requestHash}, ${expiresAt})
      ON CONFLICT ("key") DO NOTHING
    `;

    if (inserted === 1) {
      return { kind: 'new' };
    }

    const existing = (await (
      this.prisma.db as unknown as {
        $queryRaw: (
          s: TemplateStringsArray,
          ...v: unknown[]
        ) => Promise<{ requestHash: string; statusCode: number | null; responseBody: unknown }[]>;
      }
    ).$queryRaw`
      SELECT "requestHash", "statusCode", "responseBody"
      FROM "IdempotencyKey"
      WHERE "key" = ${key}
      LIMIT 1
    `)[0];

    if (!existing) return { kind: 'new' };
    if (existing.requestHash !== requestHash) return { kind: 'mismatch' };
    if (existing.statusCode == null) {
      // A concurrent request is still in flight. Treat as mismatch-free replay
      // of a pending state — surface 409 so the caller retries with backoff.
      throw new ValidationError(
        'Idempotent request still processing, retry shortly',
        [{ field: 'Idempotency-Key', code: 'in_flight' }],
      );
    }
    return {
      kind: 'replay',
      statusCode: existing.statusCode,
      responseBody: existing.responseBody,
    };
  }

  private async recordResponse(
    key: string,
    statusCode: number,
    body: unknown,
  ): Promise<void> {
    await (
      this.prisma.db as unknown as {
        $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
      }
    ).$executeRaw`
      UPDATE "IdempotencyKey"
      SET "statusCode" = ${statusCode},
          "responseBody" = ${JSON.stringify(body)}::jsonb
      WHERE "key" = ${key}
    `;
  }
}
