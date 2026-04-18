-- Replace the permissive-on-NULL policy on OutboxEvent with two explicit
-- policies:
--
-- 1. `tenant_isolation` (for `agent_saas_app`): STRICT — businessId must
--    match current_setting. This is the app-request path.
-- 2. `outbox_worker_all` (for `outbox_worker`): full access regardless
--    of session var. This is the cron path.
--
-- Result: app code running as `agent_saas_app` cannot see cross-tenant
-- outbox rows (same safety as every other table). The cron, running as
-- `outbox_worker`, scans all tenants by design.

DROP POLICY IF EXISTS tenant_isolation ON "OutboxEvent";

-- App role: strict (like other tenant tables).
CREATE POLICY tenant_isolation ON "OutboxEvent"
  FOR ALL
  TO agent_saas_app
  USING (
    "businessId" = current_setting('app.current_business_id', TRUE)
  )
  WITH CHECK (
    "businessId" = current_setting('app.current_business_id', TRUE)
  );

-- Outbox worker: full access.
CREATE POLICY outbox_worker_all ON "OutboxEvent"
  FOR ALL
  TO outbox_worker
  USING (true)
  WITH CHECK (true);

-- FORCE remains enabled so that even the table owner (the migrator role)
-- is subject to policies — only outbox_worker and agent_saas_app have
-- explicit policies.
