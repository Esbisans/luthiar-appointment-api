-- Row-Level Security (RLS) migration
--
-- Strategy: defense in depth.
--   • App layer (Prisma extension) injects businessId into every query.
--   • DB layer (this migration) enforces the same rule via Postgres policies.
--
-- Each query from `prisma.db.*` runs inside a transaction that first calls
--   SELECT set_config('app.current_business_id', '<id>', TRUE)
-- so `current_setting('app.current_business_id', TRUE)` returns the tenant id.
--
-- Policies are PERMISSIVE in the absence of a tenant context (empty string),
-- which is what lets `prisma.raw.*` work for auth and admin operations that
-- run before a tenant is known. Any query that uses the extension sets the
-- context first, so `prisma.db.*` is always tenant-scoped.
--
-- FORCE ROW LEVEL SECURITY is applied so policies bind the table owner too
-- (the app connects as owner in dev/prod).

-- ── Helper: apply RLS + policy to a businessId-scoped table ─────────────────
-- We repeat the three statements per table because PL/pgSQL functions would
-- require extra perms to create; inlined SQL keeps the migration portable.

-- 1. Business — filter by id (this table IS the tenant)
ALTER TABLE "Business" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Business" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Business"
  FOR ALL
  USING (
    "id" = current_setting('app.current_business_id', TRUE)
    OR current_setting('app.current_business_id', TRUE) = ''
  )
  WITH CHECK (
    "id" = current_setting('app.current_business_id', TRUE)
    OR current_setting('app.current_business_id', TRUE) = ''
  );

-- 2. User — has businessId, but auth queries use prisma.raw (no tenant ctx)
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "User"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
    OR current_setting('app.current_business_id', TRUE) = ''
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
    OR current_setting('app.current_business_id', TRUE) = ''
  );

-- 3–17. Tenant tables with businessId
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
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL
        USING (
          "businessId" = current_setting('app.current_business_id', TRUE)
          OR current_setting('app.current_business_id', TRUE) = ''
        )
        WITH CHECK (
          "businessId" = current_setting('app.current_business_id', TRUE)
          OR current_setting('app.current_business_id', TRUE) = ''
        )
    $f$, t);
  END LOOP;
END $$;

-- RefreshToken has no businessId (linked via userId). Left without RLS —
-- auth flows use prisma.raw and validate ownership explicitly via userId.
