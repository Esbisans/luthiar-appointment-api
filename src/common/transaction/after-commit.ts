import { ClsService } from 'nestjs-cls';

/**
 * Generic post-commit hook registry scoped to the current request's CLS.
 *
 * Why this exists: Prisma has no native `afterCommit` callback (issue
 * #9083 open since 2021). Inside a request the transactional outbox
 * must INSERT into OutboxEvent *inside* the tx, but the flush that
 * hands the row to BullMQ must run *after* COMMIT — otherwise the
 * outbox_worker role (separate connection) can't see the row due to
 * MVCC isolation.
 *
 * Pattern (mirrors Spring's `@TransactionalEventListener(AFTER_COMMIT)`,
 * Django's `transaction.on_commit()`, Laravel's `DB::afterCommit()`,
 * typeorm-transactional's `runOnTransactionCommit()`): services push
 * callbacks onto a CLS-stored list; the transaction manager
 * (TenantTxInterceptor) drains the list after `$transaction()`
 * resolves.
 *
 * The interceptor does NOT know what the hooks do — any module
 * (outbox, audit log, webhook dispatcher, email queue) can register
 * its own without coupling back to the interceptor.
 */

const AFTER_COMMIT_KEY = 'tx:afterCommit';

export type AfterCommitHook = () => void;

/**
 * Register a callback to run after the current request's transaction
 * commits successfully. No-op if called outside a tenant request (no
 * active tx → hook would never fire).
 */
export function registerAfterCommit(
  cls: ClsService,
  fn: AfterCommitHook,
): void {
  const existing = cls.get<AfterCommitHook[]>(AFTER_COMMIT_KEY) ?? [];
  existing.push(fn);
  cls.set(AFTER_COMMIT_KEY, existing);
}

/**
 * Drains and runs every registered hook. Each hook is isolated: a throw
 * in one does NOT cancel the others. The caller (interceptor) already
 * logs / reports via its own error handler.
 *
 * Called by TenantTxInterceptor after `$transaction` resolves.
 */
export function runAfterCommitHooks(cls: ClsService): void {
  const hooks = cls.get<AfterCommitHook[]>(AFTER_COMMIT_KEY);
  if (!hooks?.length) return;
  cls.set(AFTER_COMMIT_KEY, undefined);
  for (const fn of hooks) {
    try {
      fn();
    } catch {
      // Hooks are responsible for their own error handling; swallow
      // here so one bad hook can't block the others.
    }
  }
}
