import type TestAgent from 'supertest/lib/agent';

export interface RegisteredTenant {
  accessToken: string;
  refreshToken: string;
  businessId: string;
  userId: string;
  email: string;
  slug: string;
}

let counter = 0;
function uniq(): string {
  counter += 1;
  return `${Date.now()}${counter}`;
}

export async function registerTenant(
  client: TestAgent,
  overrides: Partial<{ slug: string; email: string; name: string }> = {},
): Promise<RegisteredTenant> {
  const id = uniq();
  const payload = {
    email: overrides.email ?? `owner-${id}@test.dev`,
    password: 'Password123!',
    name: overrides.name ?? `Owner ${id}`,
    businessName: `Biz ${id}`,
    slug: overrides.slug ?? `biz-${id}`,
  };
  // Opt into mobile-shape response so tokens come back in the body —
  // every existing test reads `res.body.accessToken` for `Authorization:
  // Bearer …` headers. The web/cookie path is exercised by the dedicated
  // `auth-cookies.e2e-spec.ts` suite.
  const res = await client
    .post('/auth/register')
    .set('x-client', 'mobile')
    .send(payload)
    .expect(201);
  return {
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    businessId: res.body.business.id,
    userId: res.body.user.id,
    email: payload.email,
    slug: payload.slug,
  };
}

export function bearer(tenant: RegisteredTenant): string {
  return `Bearer ${tenant.accessToken}`;
}
