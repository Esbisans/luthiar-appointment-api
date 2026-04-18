-- Add admin / forensics fields to ApiKey for the new admin endpoints.
-- The plaintext key is shown ONCE at creation; we keep prefix + last4
-- for UI / audit, soft-delete via revokedAt (never hard-delete revoked
-- keys — forensic value), and per-key telemetry (lastUsedIp, lastUsedUa,
-- callCount) written from the auth guard.

-- DropIndex (replaced by composite below)
DROP INDEX IF EXISTS "ApiKey_businessId_idx";

-- AlterTable: new columns
ALTER TABLE "ApiKey"
  ADD COLUMN IF NOT EXISTS "callCount"   INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "createdById" TEXT,
  ADD COLUMN IF NOT EXISTS "lastUsedIp"  TEXT,
  ADD COLUMN IF NOT EXISTS "lastUsedUa"  TEXT,
  ADD COLUMN IF NOT EXISTS "revokedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revokedById" TEXT;

-- last4 is required, but the table may already have rows in some envs.
-- Add nullable, backfill, then enforce NOT NULL.
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "last4" TEXT;
UPDATE "ApiKey" SET "last4" = '____' WHERE "last4" IS NULL;
ALTER TABLE "ApiKey" ALTER COLUMN "last4" SET NOT NULL;

-- New index for OWNER admin listing (filter by tenant + revoked status).
CREATE INDEX IF NOT EXISTS "ApiKey_businessId_revokedAt_idx"
  ON "ApiKey"("businessId", "revokedAt");

-- ── RLS policy: NULL-safe (same pattern as User / RefreshToken) ─────
-- The auth guard looks up an API key BEFORE knowing which tenant it
-- belongs to (the lookup is keyed by SHA-256 of the secret). With the
-- original strict policy, the lookup ran with no `app.current_business_id`
-- set and matched zero rows. Mirroring User's policy: allow reads when
-- the session has no tenant context (auth phase) AND enforce tenant
-- isolation otherwise. The keyHash column is itself the security
-- boundary — only the holder of the plaintext can find the row.

DROP POLICY IF EXISTS tenant_isolation ON "ApiKey";
CREATE POLICY tenant_isolation ON "ApiKey"
  FOR ALL
  USING (
    COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
    OR "businessId" = current_setting('app.current_business_id', TRUE)
  )
  WITH CHECK (
    COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
    OR "businessId" = current_setting('app.current_business_id', TRUE)
  );
