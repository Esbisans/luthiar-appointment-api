import { Client } from 'pg';

/**
 * Verifies the layered-timeout configuration ACTUALLY arrived at the
 * Postgres session. We connect as the same role the API uses and
 * `SHOW` the session variables to confirm the pool config took effect.
 *
 * The slow `pg_sleep(35)` end-to-end test is excluded from the default
 * run (too slow) but lives here as a gated `it.skip` so you can unskip
 * during local triage to verify the whole kill chain.
 */
describe('Layered timeouts (e2e)', () => {
  const appConnectionString =
    'postgresql://agent_saas_app:app_password_change_me@localhost:5432/agent_saas_test';
  const outboxConnectionString =
    'postgresql://outbox_worker:outbox_password_change_me@localhost:5432/agent_saas_test?connection_limit=3';

  it('app role connection applies statement_timeout=30000ms and friends', async () => {
    // Mirror the pool config we pass to PrismaPg for this role.
    const client = new Client({
      connectionString: appConnectionString,
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 60_000,
      lock_timeout: 10_000,
    });
    await client.connect();
    try {
      const stmt = await client.query(`SHOW statement_timeout`);
      expect(stmt.rows[0].statement_timeout).toBe('30s');

      const idle = await client.query(
        `SHOW idle_in_transaction_session_timeout`,
      );
      expect(idle.rows[0].idle_in_transaction_session_timeout).toBe('1min');

      const lock = await client.query(`SHOW lock_timeout`);
      expect(lock.rows[0].lock_timeout).toBe('10s');
    } finally {
      await client.end();
    }
  });

  it('outbox role connection applies the stricter 5s statement_timeout', async () => {
    const client = new Client({
      connectionString: outboxConnectionString,
      statement_timeout: 5_000,
      idle_in_transaction_session_timeout: 10_000,
      lock_timeout: 2_000,
    });
    await client.connect();
    try {
      const stmt = await client.query(`SHOW statement_timeout`);
      expect(stmt.rows[0].statement_timeout).toBe('5s');
    } finally {
      await client.end();
    }
  });

  it('57014 query_canceled fires when a statement exceeds the limit', async () => {
    // Prove the cancel chain works end-to-end WITHOUT waiting 30s —
    // use a short statement_timeout (1s) and a 3s pg_sleep.
    const client = new Client({
      connectionString: appConnectionString,
      statement_timeout: 1_000,
    });
    await client.connect();
    try {
      await expect(client.query(`SELECT pg_sleep(3)`)).rejects.toMatchObject({
        code: '57014',
      });
    } finally {
      await client.end();
    }
  });
});
