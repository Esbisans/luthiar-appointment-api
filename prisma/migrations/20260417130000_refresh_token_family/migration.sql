-- Refresh token rotation with family + reuse detection (Supabase-style).
-- Reference: RFC 9700 §4.14, Supabase auth (`internal/models/refresh_token.go`).
--
-- Strategy for safe migration over a live system:
--   1. Add new columns nullable / with safe defaults.
--   2. Backfill: each existing row becomes its own one-row family
--      (`familyId = id`). Existing tokens keep working until they expire
--      naturally (≤7d) — no forced logouts on deploy.
--   3. Enforce NOT NULL + add unique index on `tokenHash` after
--      backfill.

-- ── New columns (nullable for backfill) ─────────────────────────────
ALTER TABLE "RefreshToken"
  ADD COLUMN IF NOT EXISTS "businessId"        TEXT,
  ADD COLUMN IF NOT EXISTS "familyId"          TEXT,
  ADD COLUMN IF NOT EXISTS "parentId"          TEXT,
  ADD COLUMN IF NOT EXISTS "absoluteExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revokedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "replacedAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reusedAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "userAgent"         TEXT,
  ADD COLUMN IF NOT EXISTS "ip"                TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt"         TIMESTAMP(3);

-- ── Backfill ───────────────────────────────────────────────────────
-- familyId = own id (each existing token becomes a singleton family)
UPDATE "RefreshToken" SET "familyId" = "id" WHERE "familyId" IS NULL;

-- absoluteExpiresAt = expiresAt (already capped at 7d for legacy; new
-- rows compute familyCreated + 90d)
UPDATE "RefreshToken"
   SET "absoluteExpiresAt" = "expiresAt"
 WHERE "absoluteExpiresAt" IS NULL;

-- businessId backfilled from User join
UPDATE "RefreshToken" rt
   SET "businessId" = u."businessId"
  FROM "User" u
 WHERE rt."userId" = u."id"
   AND rt."businessId" IS NULL;

-- updatedAt = createdAt for legacy rows; trigger / @updatedAt handles
-- new rows from here on
UPDATE "RefreshToken"
   SET "updatedAt" = "createdAt"
 WHERE "updatedAt" IS NULL;

-- ── Enforce NOT NULL on backfilled columns ──────────────────────────
ALTER TABLE "RefreshToken"
  ALTER COLUMN "businessId"        SET NOT NULL,
  ALTER COLUMN "familyId"          SET NOT NULL,
  ALTER COLUMN "absoluteExpiresAt" SET NOT NULL,
  ALTER COLUMN "updatedAt"         SET NOT NULL,
  ALTER COLUMN "updatedAt"         SET DEFAULT CURRENT_TIMESTAMP;

-- ── Indexes & constraints ───────────────────────────────────────────
-- Unique on tokenHash → O(1) lookup, replaces the legacy findMany+
-- argon2.verify loop (which forced a full per-user table scan + N
-- argon2 verifies — DoS-prone).
CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_tokenHash_key"
  ON "RefreshToken"("tokenHash");

-- Drop legacy `userId` only-index (replaced by composite below).
DROP INDEX IF EXISTS "RefreshToken_userId_idx";

CREATE INDEX IF NOT EXISTS "RefreshToken_userId_revokedAt_idx"
  ON "RefreshToken"("userId", "revokedAt");
CREATE INDEX IF NOT EXISTS "RefreshToken_familyId_idx"
  ON "RefreshToken"("familyId");
CREATE INDEX IF NOT EXISTS "RefreshToken_businessId_idx"
  ON "RefreshToken"("businessId");

-- ── Self-FK for parent chain (audit trail) ──────────────────────────
ALTER TABLE "RefreshToken"
  DROP CONSTRAINT IF EXISTS "RefreshToken_parentId_fkey";
ALTER TABLE "RefreshToken"
  ADD CONSTRAINT "RefreshToken_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "RefreshToken"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
