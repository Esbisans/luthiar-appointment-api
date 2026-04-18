-- Append-only audit log. Two layers of immutability:
--   1. REVOKE UPDATE/DELETE/TRUNCATE from the app role (the only role
--      that can write here from the request path). Belt.
--   2. Trigger that raises EXCEPTION on any UPDATE/DELETE attempt.
--      Suspenders — catches the case where a future migration grants
--      back DML by accident.
--
-- Schema follows the convergent SaaS audit shape (Stripe events +
-- CloudTrail userIdentity):
--   actor (who) → action (verb) → target (what) → context (where/how)
--   + changes[] diff or full snapshot
-- All keyed by businessId for RLS isolation; mode-aware via isTest so
-- live and test event logs stay disjoint.

-- ── Table ──────────────────────────────────────────────────────────
CREATE TABLE "AuditEvent" (
  "id"             TEXT         PRIMARY KEY,             -- ULID
  "businessId"     TEXT         NOT NULL DEFAULT current_setting('app.current_business_id', TRUE),
  "occurredAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Actor
  "actorType"      TEXT         NOT NULL,                -- 'user' | 'api_key' | 'system'
  "actorId"        TEXT,
  "actorLabel"     TEXT,                                 -- cached email / name for display
  "authMethod"     TEXT,                                 -- 'jwt' | 'apikey' | NULL
  "apiKeyId"       TEXT,

  -- Action & target
  "action"         TEXT         NOT NULL,                -- 'appointment.cancelled', etc.
  "targetType"     TEXT         NOT NULL,                -- 'appointment'
  "targetId"       TEXT         NOT NULL,

  -- Payload — diff is cheap; snapshot is for regulated resources
  "changes"        JSONB,                                -- [{field, from, to}]
  "snapshotBefore" JSONB,
  "snapshotAfter"  JSONB,
  "outcome"        TEXT         NOT NULL DEFAULT 'success',  -- 'success' | 'failure'
  "errorCode"      TEXT,

  -- Request context (mirrors the CLS keys Pino already serialises)
  "traceId"        TEXT,
  "requestId"      TEXT,
  "ipAddress"      TEXT,
  "userAgent"      TEXT,
  "isTest"         BOOLEAN      NOT NULL DEFAULT COALESCE(
                                  NULLIF(current_setting('app.current_is_test', TRUE), '')::boolean,
                                  FALSE
                                )
);

-- Composite indexes mirror the dashboard query patterns:
--   resource history:  WHERE businessId, targetType, targetId ORDER BY occurredAt DESC
--   actor activity:    WHERE businessId, actorId ORDER BY occurredAt DESC
--   action filter:     WHERE businessId, action ORDER BY occurredAt DESC
--   mode partition:    WHERE businessId, isTest ORDER BY occurredAt DESC
CREATE INDEX "AuditEvent_target_idx"
  ON "AuditEvent"("businessId", "targetType", "targetId", "occurredAt" DESC);
CREATE INDEX "AuditEvent_actor_idx"
  ON "AuditEvent"("businessId", "actorId", "occurredAt" DESC);
CREATE INDEX "AuditEvent_action_idx"
  ON "AuditEvent"("businessId", "action", "occurredAt" DESC);
CREATE INDEX "AuditEvent_mode_idx"
  ON "AuditEvent"("businessId", "isTest", "occurredAt" DESC);
-- BRIN for time-range scans on the long tail (cheap, append-only friendly).
CREATE INDEX "AuditEvent_occurredAt_brin"
  ON "AuditEvent" USING BRIN ("occurredAt");

-- ── RLS (mode-aware, mirrors the rest of the partition) ────────────
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditEvent"
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

-- ── Append-only enforcement ────────────────────────────────────────
-- Layer 1: revoke DML except INSERT/SELECT for the app role. The
-- migration_role still has UPDATE/DELETE so future schema changes work.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditEvent" FROM PUBLIC;
GRANT INSERT, SELECT ON "AuditEvent" TO agent_saas_app;
GRANT INSERT, SELECT ON "AuditEvent" TO outbox_worker;

-- Layer 2: trigger that catches any UPDATE/DELETE no matter the role.
-- Belt + suspenders: a future privileged role accidentally getting DML
-- still hits this and blows up loudly.
CREATE OR REPLACE FUNCTION audit_event_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only — UPDATE/DELETE forbidden';
END;
$$;

CREATE TRIGGER audit_event_no_mutate
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_event_immutable();
