-- Test mode / sandbox partitioning — Stripe-style livemode pattern.
--
-- Adds `isTest Boolean DEFAULT FALSE` to the 8 tables that hold
-- per-call transactional data. Catalog/config tables (Service, Staff,
-- StaffService, BusinessHour, Holiday, BlockedTime, StaffAvailability)
-- stay shared: a test-mode agent books against the same real service
-- catalog — only the resulting Appointment/Customer/Conversation/etc.
-- rows are partitioned.
--
-- Enforcement is two-layered:
--   1. DB (RLS): USING business_id = ? AND is_test = ?  — absolute guarantee.
--   2. App (Prisma extension): injects `isTest` into every where/data —
--      cleaner SQL, static analysis, belt + suspenders.
--
-- Session var `app.current_is_test` set by TenantTxInterceptor from CLS;
-- CLS populated by AuthGuard from the API-key prefix (`agnt_test_` → true)
-- or JWT (defaults to live unless dashboard toggle is in play — future).

-- ── Columns ──────────────────────────────────────────────────────────
ALTER TABLE "Appointment"      ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "Customer"         ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "Conversation"     ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "Message"          ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "Payment"          ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "Notification"     ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "OutboxEvent"      ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "IdempotencyKey"   ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT FALSE;

-- ── DB DEFAULT for isTest derived from the session var ──────────────
-- Mirrors the businessId DEFAULT pattern (see docs/prisma-quirks.md Q4).
-- Rows inserted without an explicit isTest will inherit the session var —
-- fail-closed to FALSE if the var isn't set (live mode).
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'Appointment','Customer','Conversation','Message','Payment',
      'Notification','OutboxEvent','IdempotencyKey'
    ])
  LOOP
    EXECUTE format(
      $ddl$
        ALTER TABLE %I ALTER COLUMN "isTest"
          SET DEFAULT COALESCE(
            NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
            FALSE
          )
      $ddl$,
      t
    );
  END LOOP;
END$$;

-- ── RLS: extend tenant_isolation policy to also match isTest ────────
-- Drop and recreate; adding AND to existing USING clause requires rewrite.

-- Appointment uses the NULL-tolerant pattern (auth paths don't hit it;
-- but consistency matters for dashboard bootstrap).
DROP POLICY IF EXISTS tenant_isolation ON "Appointment";
CREATE POLICY tenant_isolation ON "Appointment"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON "Customer";
CREATE POLICY tenant_isolation ON "Customer"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON "Conversation";
CREATE POLICY tenant_isolation ON "Conversation"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON "Message";
CREATE POLICY tenant_isolation ON "Message"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON "Payment";
CREATE POLICY tenant_isolation ON "Payment"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON "Notification";
CREATE POLICY tenant_isolation ON "Notification"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  );

-- OutboxEvent has TWO policies (app role + outbox_worker with USING true).
-- We only mode-gate the app policy; outbox_worker must see ALL rows
-- (cross-tenant + cross-mode) to fan out to queues.
DROP POLICY IF EXISTS tenant_isolation ON "OutboxEvent";
CREATE POLICY tenant_isolation ON "OutboxEvent"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON "IdempotencyKey";
CREATE POLICY tenant_isolation ON "IdempotencyKey"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
    AND "isTest" = COALESCE(
      NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
      FALSE
    )
  );

-- ── Customer unique constraint must include isTest ────────────────
-- Old: (businessId, phone) collapsed live+test customers with the same
-- phone into a conflict. New: (businessId, isTest, phone) lets the same
-- phone exist in both modes without collision.
ALTER TABLE "Customer" DROP CONSTRAINT IF EXISTS "Customer_businessId_phone_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_businessId_isTest_phone_key"
  ON "Customer"("businessId", "isTest", "phone");

-- ── Composite indexes for hot-path queries ──────────────────────────
CREATE INDEX IF NOT EXISTS "Appointment_businessId_isTest_startTime_idx"
  ON "Appointment"("businessId", "isTest", "startTime" DESC);
CREATE INDEX IF NOT EXISTS "Conversation_businessId_isTest_startedAt_idx"
  ON "Conversation"("businessId", "isTest", "startedAt" DESC);
