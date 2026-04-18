-- ─────────────────────────────────────────────────────────────────────────
-- Database role setup (idempotent).
--
-- Run ONCE per environment, as a SUPERUSER, BEFORE the first
-- `prisma migrate deploy`. Creating roles requires superuser privileges
-- and is therefore kept out of Prisma migrations (which run as the app
-- role in CI).
--
-- Roles:
--   • agent_saas_app   — runtime role. NOSUPERUSER, NOBYPASSRLS, subject
--                        to RLS. DATABASE_URL points here.
--   • <superuser>      — env-specific (existing). MIGRATION_DATABASE_URL
--                        points here. Owns the schema and runs migrations.
--
-- Usage (password MUST come from the environment — no insecure default):
--
--   psql -d agent_saas \
--        -v app_password="'$AGENT_SAAS_APP_PASSWORD'" \
--        -f prisma/sql/00-init-roles.sql
--
-- AGENT_SAAS_APP_PASSWORD must be supplied by the CI secret store
-- (AWS Secrets Manager, GCP Secret Manager, Vault, GitHub Actions secret,
-- Fly/Railway native secrets). Never commit it.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

-- Fail loudly if the password variable wasn't supplied.
-- `:'app_password'` unquoted via `:app_password` would expand to the literal
-- `:app_password` string when missing; `current_setting` on an unset
-- variable would error out. We use a DO block with pg_settings lookup.
DO $check$
DECLARE
  pwd text;
BEGIN
  -- Reading a psql var in DO is via current_setting once it's been `\set`.
  -- If not set, the SELECT below raises — intentional.
  BEGIN
    pwd := current_setting('my.app_password');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '[roles] my.app_password GUC is not set. Invoke with: psql -c "SET my.app_password TO ''<pwd>''" -f prisma/sql/00-init-roles.sql  (and supply <pwd> from a secret store).';
  END;

  IF pwd IS NULL OR length(pwd) = 0 THEN
    RAISE EXCEPTION '[roles] my.app_password is empty — refusing to create role.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_saas_app') THEN
    EXECUTE format(
      'CREATE ROLE agent_saas_app WITH LOGIN PASSWORD %L',
      pwd
    );
  ELSE
    EXECUTE format(
      'ALTER ROLE agent_saas_app WITH LOGIN PASSWORD %L',
      pwd
    );
  END IF;
END
$check$;

-- Re-apply every run (cheap, keeps the role configured as intended).
ALTER ROLE agent_saas_app NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB INHERIT LOGIN;

GRANT USAGE ON SCHEMA public TO agent_saas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agent_saas_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agent_saas_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent_saas_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agent_saas_app;
