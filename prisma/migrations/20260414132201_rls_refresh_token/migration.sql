-- RLS on RefreshToken via JOIN to User.
--
-- RefreshToken has no businessId column (it links to a User, which has one).
-- Rather than denormalize, we use a JOIN-based policy: a row is visible
-- only if the owning user belongs to the current tenant. Same pattern used
-- by Supabase's auth.refresh_tokens.
--
-- Auth paths (login/register/refresh) don't run inside the tenant interceptor,
-- so they have no SET LOCAL. We make the policy permissive when the session
-- variable is empty — consistent with User/Business tables. The app layer
-- guarantees userId ownership (JWT payload, tokenHash verification).
--
-- With SET LOCAL set (in-tenant requests), only the tenant's own refresh
-- tokens are visible — defense in depth against cross-tenant token leak
-- via e.g. an admin endpoint that lists sessions.

ALTER TABLE "RefreshToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefreshToken" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "RefreshToken";

CREATE POLICY tenant_isolation ON "RefreshToken"
  FOR ALL
  USING (
    COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
    OR EXISTS (
      SELECT 1 FROM "User" u
      WHERE u."id" = "RefreshToken"."userId"
        AND u."businessId" = current_setting('app.current_business_id', TRUE)
    )
  )
  WITH CHECK (
    COALESCE(current_setting('app.current_business_id', TRUE), '') = ''
    OR EXISTS (
      SELECT 1 FROM "User" u
      WHERE u."id" = "RefreshToken"."userId"
        AND u."businessId" = current_setting('app.current_business_id', TRUE)
    )
  );

-- userId index already exists (see schema.prisma @@index([userId])), so the
-- EXISTS subquery stays cheap. Verify with \d "RefreshToken" in psql.
