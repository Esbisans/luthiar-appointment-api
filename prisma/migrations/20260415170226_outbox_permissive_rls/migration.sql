-- OutboxEvent RLS becomes permissive when no tenant context is set.
--
-- The outbox safety-net cron (BullMQ repeatable `outbox-flush`) runs
-- OUTSIDE any request, so there is no CLS-scoped businessId at query
-- time. It needs to list PENDING rows across all tenants, inspect each
-- row's own `businessId` column, and dispatch to BullMQ with the correct
-- per-row context.
--
-- Risks mitigated:
--   • Same pattern already used for User and Business — cron/auth code
--     needs cross-tenant reads with per-row explicit filtering.
--   • Application-layer access to OutboxEvent happens only through
--     OutboxService, which either runs inside a tenant tx (writes) or is
--     the cron (reads-all). No ad-hoc code touches this table.

DROP POLICY IF EXISTS tenant_isolation ON "OutboxEvent";

CREATE POLICY tenant_isolation ON "OutboxEvent"
  FOR ALL
  USING (
    COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
    OR "businessId" = current_setting('app.current_business_id', TRUE)
  )
  WITH CHECK (
    COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
    OR "businessId" = current_setting('app.current_business_id', TRUE)
  );
