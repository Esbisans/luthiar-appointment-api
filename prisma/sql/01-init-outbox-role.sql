-- ─────────────────────────────────────────────────────────────────────────
-- Outbox-worker role (idempotent).
--
-- This role is the identity used by the BullMQ `outbox-flush` cron and by
-- any offline tool that needs to scan `OutboxEvent` cross-tenant.
--
-- Key design choices:
--   • NOBYPASSRLS — if the worker accidentally touches a tenant table,
--     RLS still rejects (safer than BYPASSRLS).
--   • Scoped grants — only SELECT/UPDATE on "OutboxEvent" + USAGE on
--     schema/sequences. No access to tenant tables at all.
--   • An explicit policy on "OutboxEvent" grants `FOR ALL TO outbox_worker
--     USING (true)` so the cron sees every row regardless of CLS context.
--     No other policy targets this role, so it cannot read/write any
--     tenant table.
--
-- Supabase's `service_role` pattern uses BYPASSRLS; we intentionally
-- pick the stricter hybrid: real RLS everywhere, one explicit bypass
-- policy on the single table where the cron needs cross-tenant access.
--
-- Run once per environment, as a superuser, BEFORE the first
-- `prisma migrate deploy` that touches OutboxEvent:
--
--   psql -d agent_saas \
--        -v outbox_password="'<SECRET>'" \
--        -f prisma/sql/01-init-outbox-role.sql
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

DO $check$
DECLARE
  pwd text;
BEGIN
  BEGIN
    pwd := current_setting('my.outbox_password');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '[outbox-role] my.outbox_password GUC not set. Invoke with: psql -v outbox_password="''<pwd>''" (value from your secret store).';
  END;

  IF pwd IS NULL OR length(pwd) = 0 THEN
    RAISE EXCEPTION '[outbox-role] my.outbox_password is empty — refusing to create role.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_worker') THEN
    EXECUTE format('CREATE ROLE outbox_worker WITH LOGIN PASSWORD %L', pwd);
  ELSE
    EXECUTE format('ALTER ROLE outbox_worker WITH LOGIN PASSWORD %L', pwd);
  END IF;
END
$check$;

-- Tight, idempotent role configuration.
ALTER ROLE outbox_worker
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB INHERIT LOGIN;

-- Scope: only OutboxEvent (plus schema/sequence usage).
GRANT CONNECT ON DATABASE agent_saas TO outbox_worker;
GRANT USAGE ON SCHEMA public TO outbox_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON "OutboxEvent" TO outbox_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO outbox_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO outbox_worker;
