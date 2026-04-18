import { Prisma } from '../generated/prisma/client.js';
import { ClsServiceManager } from 'nestjs-cls';

/**
 * Tenant-isolation extension — application-layer guard.
 *
 * Responsibilities:
 *   • Inject `where.businessId` on read-like operations, so Prisma generates
 *     tenant-scoped SQL (useful for logs/explain, and a second barrier on
 *     top of RLS).
 *   • Inject `data.businessId` on top-level creates (nested creates rely on
 *     the Postgres DEFAULT on the column, set by the RLS migration).
 *
 * NOT responsibilities:
 *   • Opening transactions or running SET LOCAL. The per-request
 *     TenantTxInterceptor owns the interactive tx and sets the session
 *     variable once. This lets interactive `$transaction(async tx => ...)`
 *     work naturally — operations inherit the tx and its session context.
 *
 * Excluded models:
 *   • Business — the table IS the tenant (matched by id, not businessId).
 *   • User, RefreshToken — auth paths run before a tenant context exists.
 *
 * For non-tenant operations (auth, cross-tenant admin), use the raw client
 * via `prisma.<model>` directly (PrismaService extends PrismaClient).
 */

const EXCLUDED_MODELS = new Set(['Business', 'User', 'RefreshToken']);

/**
 * Tables carrying the Stripe-style `isTest` partition column. The
 * extension injects it on top of the existing `businessId` injection so
 * queries automatically scope to the caller's mode. RLS on Postgres is
 * the primary guarantee; this is ergonomic belt-and-suspenders.
 */
const TEST_MODE_MODELS = new Set([
  'Appointment',
  'Customer',
  'Conversation',
  'Message',
  'Payment',
  'Notification',
  'OutboxEvent',
  'IdempotencyKey',
]);

function getIsTest(): boolean {
  try {
    return (
      ClsServiceManager.getClsService().get<boolean | undefined>('isTest') ===
      true
    );
  } catch {
    return false;
  }
}

const READ_LIKE_OPS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

function getBusinessId(): string | undefined {
  try {
    return ClsServiceManager.getClsService().get<string>('businessId');
  } catch {
    return undefined;
  }
}

function assertTenant(op: string): string {
  const businessId = getBusinessId();
  if (!businessId) {
    throw new Error(
      `[tenant] ${op} requires a tenant context. Use prisma.db inside an ` +
        `authenticated request (TenantTxInterceptor) — not prisma.extended ` +
        `or the raw PrismaClient.`,
    );
  }
  return businessId;
}

export const tenantExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (EXCLUDED_MODELS.has(model)) {
            return query(args);
          }

          const businessId = assertTenant(`${model}.${operation}`);
          const a = args as Record<string, unknown>;
          const isTestModel = TEST_MODE_MODELS.has(model);
          const isTest = isTestModel ? getIsTest() : undefined;

          if (CREATE_OPS.has(operation)) {
            const data = a['data'];
            if (Array.isArray(data)) {
              a['data'] = data.map((d: Record<string, unknown>) => ({
                businessId,
                ...(isTestModel ? { isTest } : {}),
                ...d,
              }));
            } else if (data && typeof data === 'object') {
              a['data'] = {
                businessId,
                ...(isTestModel ? { isTest } : {}),
                ...(data as object),
              };
            }
          } else if (READ_LIKE_OPS.has(operation)) {
            a['where'] = {
              ...((a['where'] as object) ?? {}),
              businessId,
              ...(isTestModel ? { isTest } : {}),
            };
          }

          return query(args);
        },
      },
      // Client-level raw query handlers. These run for `prisma.db.$queryRaw`
      // etc. They don't rewrite SQL (that would be unsafe); they enforce the
      // tenant-context invariant so raw queries only run inside a request.
      // RLS at the DB layer is the real guard — this is fail-fast validation.
      async $queryRaw({ args, query }) {
        assertTenant('$queryRaw');
        return query(args);
      },
      async $executeRaw({ args, query }) {
        assertTenant('$executeRaw');
        return query(args);
      },
      async $queryRawUnsafe({ args, query }) {
        assertTenant('$queryRawUnsafe');
        return query(args);
      },
      async $executeRawUnsafe({ args, query }) {
        assertTenant('$executeRawUnsafe');
        return query(args);
      },
    },
  }),
);
