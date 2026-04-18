import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { defer, from, lastValueFrom, Observable } from 'rxjs';
import {
  CLS_TX_KEY,
  ExtendedPrismaClient,
  PrismaService,
} from '../../prisma/prisma.service.js';
import { runAfterCommitHooks } from '../transaction/after-commit.js';

/**
 * TenantTxInterceptor — opens one interactive transaction per authenticated
 * request, sets the Postgres session variable that RLS policies read from,
 * and exposes the transaction as `prisma.db` via CLS. The handler runs
 * inside the transaction; it commits on success and rolls back on error.
 *
 * Why this pattern:
 *   • RLS is enforced automatically — every tenant query in the request
 *     inherits the SET LOCAL.
 *   • Interactive `$transaction(async tx => ...)` inside handlers is no
 *     longer needed for atomicity of tenant writes; the whole request is
 *     already atomic. Multi-write handlers (e.g. book appointment + create
 *     payment) get transactional safety for free.
 *   • Nested writes work: Postgres DEFAULTs on `businessId` populate from
 *     the session variable.
 *
 * Skipped when:
 *   • No `businessId` in CLS (public routes: health, login, register).
 *     Those use `prisma.<model>` directly — no tenant context required.
 *
 * Constraints that the rest of the code must respect:
 *   • Handlers must finish within TX_TIMEOUT_MS. Prisma's default is 5s;
 *     we raise it to 15s to absorb DB contention, but NOT external calls.
 *   • Do NOT make HTTP calls to Stripe / OpenAI / SendGrid inside a
 *     handler. They can take seconds and hold the connection
 *     `idle_in_transaction`, exhausting the pool. Enqueue via BullMQ
 *     (post-response) or resolve before the handler runs.
 */

const TX_TIMEOUT_MS = 15_000;
const TX_MAX_WAIT_MS = 5_000;
@Injectable()
export class TenantTxInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    const businessId = this.cls.get<string>('businessId');
    if (!businessId) {
      return next.handle();
    }

    const isTest = this.cls.get<boolean>('isTest') === true;

    return defer(() =>
      from(
        this.prisma.extended
          .$transaction(
            async (tx) => {
              const raw = tx as unknown as {
                $executeRaw: (
                  strings: TemplateStringsArray,
                  ...values: unknown[]
                ) => Promise<number>;
              };
              // Two session vars: businessId (tenant scope) and is_test
              // (live/test partition). Both read by every RLS policy on
              // partitioned tables; catalog tables (Service, Staff, ...)
              // only check businessId.
              await raw.$executeRaw`SELECT set_config('app.current_business_id', ${businessId}, TRUE)`;
              await raw.$executeRaw`SELECT set_config('app.current_is_test', ${isTest ? 'true' : 'false'}, TRUE)`;

              this.cls.set(CLS_TX_KEY, tx as unknown as ExtendedPrismaClient);

              try {
                return await lastValueFrom(next.handle());
              } finally {
                this.cls.set(CLS_TX_KEY, undefined);
              }
            },
            { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
          )
          .then((result) => {
            // Tx is committed — drain any callbacks registered via
            // `registerAfterCommit()`. The interceptor stays agnostic of
            // what the hooks do (outbox flush, audit, webhooks, etc.).
            runAfterCommitHooks(this.cls);
            return result;
          }),
      ),
    );
  }
}
