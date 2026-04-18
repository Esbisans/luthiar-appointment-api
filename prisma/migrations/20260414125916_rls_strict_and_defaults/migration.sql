-- ─────────────────────────────────────────────────────────────────────────
-- Strict RLS redesign + DB-level tenant defaults.
--
-- Previous migrations used a permissive-on-NULL policy on all tables, which
-- meant any query without a tenant context saw everything. That defeats
-- defense in depth. This migration:
--
-- 1. Makes tenant-table policies STRICT:
--      USING ("businessId" = current_setting('app.current_business_id', TRUE))
--    With no context, 0 rows are visible. The app wraps every tenant
--    request in a tx that sets the context.
--
-- 2. Keeps User / Business policies PERMISSIVE (these are needed by auth
--    flows that run BEFORE a tenant context exists: login, register, slug
--    uniqueness). Auth is still protected by the app layer (password,
--    token) — RLS on these tables is just a secondary guard.
--
-- 3. Sets a DB default on every "businessId" column:
--      DEFAULT current_setting('app.current_business_id', TRUE)
--    Combined with the per-request tx that sets the context, this means
--    INSERTs (including nested writes, raw SQL, and app-layer inserts that
--    forget to set businessId) are auto-populated from the session. Null
--    falls through to the NOT NULL constraint — fail-closed by design.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Rewrite policies ────────────────────────────────────────────────────

-- Permissive tables (auth paths without tenant context need them).
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['Business', 'User']) LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
  END LOOP;
END $$;

CREATE POLICY tenant_isolation ON "Business"
  FOR ALL
  USING (
    COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
    OR "id" = current_setting('app.current_business_id', TRUE)
  )
  WITH CHECK (
    COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
    OR "id" = current_setting('app.current_business_id', TRUE)
  );

CREATE POLICY tenant_isolation ON "User"
  FOR ALL
  USING (
    COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
    OR "businessId" = current_setting('app.current_business_id', TRUE)
  )
  WITH CHECK (
    COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
    OR "businessId" = current_setting('app.current_business_id', TRUE)
  );

-- Strict tenant tables.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'Staff',
      'Service',
      'StaffService',
      'Customer',
      'BusinessHour',
      'StaffAvailability',
      'BlockedTime',
      'Holiday',
      'Appointment',
      'Payment',
      'Conversation',
      'Message',
      'Notification',
      'NotificationSetting',
      'ApiKey'
    ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL
        USING (
          "businessId" = current_setting('app.current_business_id', TRUE)
        )
        WITH CHECK (
          "businessId" = current_setting('app.current_business_id', TRUE)
        )
    $f$, t);
  END LOOP;
END $$;

-- ── 2. DB-level defaults for businessId ───────────────────────────────────
-- Auto-populates businessId from the session context. The app does NOT need
-- to pass businessId explicitly anymore — not even for nested writes.

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'Staff',
      'Service',
      'StaffService',
      'Customer',
      'BusinessHour',
      'StaffAvailability',
      'BlockedTime',
      'Holiday',
      'Appointment',
      'Payment',
      'Conversation',
      'Message',
      'Notification',
      'NotificationSetting',
      'ApiKey',
      'User'
    ])
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN "businessId" SET DEFAULT current_setting(%L, TRUE)',
      t, 'app.current_business_id'
    );
  END LOOP;
END $$;
