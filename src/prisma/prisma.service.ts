import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { tenantExtension } from './prisma-tenant.extension.js';

/**
 * Type-only factory. `typeof` extracts the return type at compile time; the
 * function is never called (it takes a required argument, so an accidental
 * call is a type error rather than a runtime pool leak).
 */
const _extendedTypeFactory = (c: PrismaClient) => c.$extends(tenantExtension);
export type ExtendedPrismaClient = ReturnType<typeof _extendedTypeFactory>;

export const CLS_TX_KEY = 'db';

/**
 * PrismaService — official NestJS pattern, extends PrismaClient.
 *
 * Surface:
 *   • `prisma.<model>`   → raw client (no tenant filter). Use for auth,
 *                          cross-tenant admin, or code that runs outside a
 *                          tenant request.
 *   • `prisma.db.<model>` → tenant-scoped client. Inside a request, this is
 *                          the interactive transaction opened by
 *                          TenantTxInterceptor (the tx inherits the
 *                          extension, so queries carry the `where`/`data`
 *                          injections and run inside the SET LOCAL scope
 *                          that RLS enforces). Outside a request, this is
 *                          the base extended client, and queries will fail
 *                          RLS if no tenant context is set — fail-closed.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  readonly extended: ExtendedPrismaClient;

  constructor(private readonly cls: ClsService) {
    super({
      adapter: new PrismaPg({
        connectionString: process.env['DATABASE_URL'],
        // ── Pool sizing ─────────────────────────────────────────────
        // 20 sockets per API instance — tuned for small SaaS scale.
        // Prisma's legacy `?connection_limit=` URL param is ignored by
        // the v7 driver adapter; `max` is the pg-native equivalent.
        max: 20,
        // ── Timeouts (defense in depth) ─────────────────────────────
        //   statement_timeout (30s) — Postgres cancels any single query
        //     past the limit and returns SQLSTATE 57014. This is the
        //     ONLY layer that actually aborts work at the DB.
        //   idle_in_transaction_session_timeout (60s) — kills a
        //     transaction that's been open with no activity, releasing
        //     row locks it was holding. Protects against leaked tx
        //     after a crashed handler.
        //   lock_timeout (10s) — if a statement waits for a row lock
        //     past this, give up instead of piling up indefinitely.
        //   connectionTimeoutMillis (5s) — time to acquire a socket
        //     from the pool; past this the request fails fast.
        //   idleTimeoutMillis (5min) — pool GC for idle sockets.
        // Values escalate: Prisma tx timeout (15s) < statement_timeout
        // (30s) < idle_in_transaction (60s) < Node server.requestTimeout
        // (60s) — each layer catches what the previous missed.
        statement_timeout: 30_000,
        idle_in_transaction_session_timeout: 60_000,
        lock_timeout: 10_000,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 300_000,
      }),
    });
    this.extended = this.$extends(tenantExtension) as ExtendedPrismaClient;
  }

  /**
   * Tenant-scoped client. Returns the request-scoped transaction if one is
   * active (the common case), otherwise the base extended client.
   */
  get db(): ExtendedPrismaClient {
    const tx = this.cls.get<ExtendedPrismaClient | undefined>(CLS_TX_KEY);
    return tx ?? this.extended;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
