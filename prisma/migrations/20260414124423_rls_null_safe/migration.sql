-- Fix RLS policies: when no tenant context is set, current_setting(..., TRUE)
-- returns NULL (not ''). Raw auth/admin queries don't set a tenant context,
-- so the policy must permit NULL too — otherwise login queries see 0 rows.
--
-- Policy semantics after this migration:
--   • tenant context set → row.businessId must match
--   • no tenant context   → row is visible (permissive for raw client)
--
-- We use COALESCE(current_setting(..., TRUE), '') = '' OR <match>
-- to cover both NULL (never set) and '' (explicitly set to empty).

DO $$
DECLARE
  t text;
BEGIN
  -- Business: filter by id
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON "Business"';
  EXECUTE $pol$
    CREATE POLICY tenant_isolation ON "Business"
      FOR ALL
      USING (
        COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
        OR "id" = current_setting('app.current_business_id', TRUE)
      )
      WITH CHECK (
        COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
        OR "id" = current_setting('app.current_business_id', TRUE)
      )
  $pol$;

  -- All other tenant tables: filter by businessId
  FOR t IN
    SELECT unnest(ARRAY[
      'User',
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
          COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
          OR "businessId" = current_setting('app.current_business_id', TRUE)
        )
        WITH CHECK (
          COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
          OR "businessId" = current_setting('app.current_business_id', TRUE)
        )
    $f$, t);
  END LOOP;
END $$;
