-- Appointments: new columns + reschedule linkage + IdempotencyKey + OutboxEvent.
-- PLUS the EXCLUDE constraint that makes double-booking structurally
-- impossible at the DB level (see docs/prisma-quirks.md for why we write
-- this migration by hand).

-- ── btree_gist extension (required for mixing = and && in EXCLUDE) ─────
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── Appointment: new columns ──────────────────────────────────────────
ALTER TABLE "Appointment"
  ADD COLUMN "cancelledByActorType" TEXT,
  ADD COLUMN "source"               TEXT,
  ADD COLUMN "metadata"             JSONB,
  ADD COLUMN "rescheduledFromId"    TEXT;

CREATE UNIQUE INDEX "Appointment_rescheduledFromId_key"
  ON "Appointment" ("rescheduledFromId");

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_rescheduledFromId_fkey"
  FOREIGN KEY ("rescheduledFromId")
  REFERENCES "Appointment" ("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- ── Generated column + EXCLUDE constraint ─────────────────────────────
-- Prisma maps DateTime → `timestamp(3) without time zone`, so we use
-- `tsrange` (the timezone-aware `tstzrange` constructor is not immutable
-- and cannot back a STORED generated column).
-- '[)' is half-open to mirror our application-level convention.
-- EXCLUDE rejects any INSERT whose (businessId, staffId) tuple would
-- overlap another live appointment. This is the atomic barrier against
-- double-booking — the application-layer availability check is pure UX.
ALTER TABLE "Appointment"
  ADD COLUMN "timeRange" tsrange
  GENERATED ALWAYS AS (tsrange("startTime", "endTime", '[)')) STORED;

ALTER TABLE "Appointment"
  ADD CONSTRAINT appointment_no_overlap
  EXCLUDE USING gist (
    "businessId" WITH =,
    "staffId"    WITH =,
    "timeRange"  WITH &&
  )
  WHERE (
    "deletedAt" IS NULL
    AND status NOT IN ('CANCELLED', 'NO_SHOW')
  );

-- ── IdempotencyKey ────────────────────────────────────────────────────
CREATE TABLE "IdempotencyKey" (
  "key"          TEXT        PRIMARY KEY,
  "businessId"   TEXT        NOT NULL DEFAULT current_setting('app.current_business_id', TRUE),
  "method"       TEXT        NOT NULL,
  "path"         TEXT        NOT NULL,
  "requestHash"  TEXT        NOT NULL,
  "statusCode"   INTEGER,
  "responseBody" JSONB,
  "resourceId"   TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"    TIMESTAMP(3) NOT NULL
);

CREATE INDEX "IdempotencyKey_businessId_idx"
  ON "IdempotencyKey" ("businessId");
CREATE INDEX "IdempotencyKey_expiresAt_idx"
  ON "IdempotencyKey" ("expiresAt");

ALTER TABLE "IdempotencyKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdempotencyKey" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "IdempotencyKey"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
  );

-- ── OutboxEvent ───────────────────────────────────────────────────────
CREATE TABLE "OutboxEvent" (
  "id"          TEXT        PRIMARY KEY,
  "businessId"  TEXT        NOT NULL DEFAULT current_setting('app.current_business_id', TRUE),
  "type"        TEXT        NOT NULL,
  "payload"     JSONB       NOT NULL,
  "status"      TEXT        NOT NULL DEFAULT 'PENDING',
  "attempts"    INTEGER     NOT NULL DEFAULT 0,
  "processedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "OutboxEvent_status_createdAt_idx"
  ON "OutboxEvent" ("status", "createdAt");
CREATE INDEX "OutboxEvent_businessId_idx"
  ON "OutboxEvent" ("businessId");

ALTER TABLE "OutboxEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboxEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OutboxEvent"
  FOR ALL
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
  );
