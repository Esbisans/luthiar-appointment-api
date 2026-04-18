import { TestApi } from './support/test-app';

/**
 * Coverage for the auth refactor:
 *   • HttpOnly cookies set/cleared on web register/login/logout.
 *   • Mobile mode (x-client header) returns tokens in body.
 *   • Refresh token rotation invalidates the old token.
 *   • Reuse detection: replay an already-rotated token → 401 + family
 *     revoked → user can no longer use any token in the family.
 *   • /auth/sessions list + revoke per-device.
 *
 * These tests are deliberately separate from `auth.e2e-spec.ts` so the
 * legacy flow stays intact and these focus on the new behaviour.
 */
describe('Auth: cookies + refresh rotation + sessions (e2e)', () => {
  const api = new TestApi();
  let counter = 0;

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
  });

  function unique() {
    counter += 1;
    return `${Date.now()}${counter}`;
  }

  async function registerWeb() {
    const id = unique();
    const res = await api.client
      .post('/auth/register')
      .send({
        email: `web-${id}@test.dev`,
        password: 'Password123!',
        name: `Web ${id}`,
        businessName: `Web Biz ${id}`,
        slug: `web-biz-${id}`,
      })
      .expect(201);
    return { res, email: `web-${id}@test.dev` };
  }

  async function registerMobile() {
    const id = unique();
    const res = await api.client
      .post('/auth/register')
      .set('x-client', 'mobile')
      .send({
        email: `mob-${id}@test.dev`,
        password: 'Password123!',
        name: `Mob ${id}`,
        businessName: `Mob Biz ${id}`,
        slug: `mob-biz-${id}`,
      })
      .expect(201);
    return { res, email: `mob-${id}@test.dev` };
  }

  // ── Web cookies ────────────────────────────────────────────────

  it('web register sets access_token + refresh_token HttpOnly cookies, no tokens in body', async () => {
    const { res } = await registerWeb();
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.user).toBeDefined();

    const setCookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const access = setCookies.find((c) => c.startsWith('access_token='));
    const refresh = setCookies.find((c) => c.startsWith('refresh_token='));
    expect(access).toBeDefined();
    expect(refresh).toBeDefined();
    expect(access).toMatch(/HttpOnly/);
    expect(access).toMatch(/SameSite=Lax/);
    expect(refresh).toMatch(/HttpOnly/);
  });

  it('web login uses cookies for subsequent /agent/context fetch', async () => {
    const { email } = await registerWeb();

    const loginRes = await api.client
      .post('/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(200);
    expect(loginRes.body.accessToken).toBeUndefined();

    const cookieHeader = (loginRes.headers['set-cookie'] as unknown as string[])
      .map((c) => c.split(';')[0])
      .join('; ');

    // Use the cookie to call an authenticated endpoint.
    await api.client
      .get('/agent/context')
      .set('Cookie', cookieHeader)
      .expect(200);
  });

  it('web logout clears cookies', async () => {
    const { res } = await registerWeb();
    const cookieHeader = (res.headers['set-cookie'] as unknown as string[])
      .map((c) => c.split(';')[0])
      .join('; ');

    const logoutRes = await api.client
      .post('/auth/logout')
      .set('Cookie', cookieHeader)
      .expect(200);
    const cleared = logoutRes.headers['set-cookie'] as unknown as string[];
    expect(cleared.some((c) => c.startsWith('access_token=;'))).toBe(true);
    expect(cleared.some((c) => c.startsWith('refresh_token=;'))).toBe(true);
  });

  // ── Mobile body mode ───────────────────────────────────────────

  it('mobile register returns tokens in body, no cookies', async () => {
    const { res } = await registerMobile();
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  // ── Refresh rotation ───────────────────────────────────────────

  it('refresh rotates the token and the old one is no longer valid', async () => {
    const { res } = await registerMobile();
    const r1 = res.body.refreshToken;
    await new Promise((r) => setTimeout(r, 50));

    const refresh1 = await api.client
      .post('/auth/refresh')
      .set('x-client', 'mobile')
      .send({ refreshToken: r1 })
      .expect(200);
    const r2 = refresh1.body.refreshToken;
    expect(r2).not.toBe(r1);

    // Replaying the original token should now fire the grace-window
    // branch (within 10s) → 401.
    const replay = await api.client
      .post('/auth/refresh')
      .set('x-client', 'mobile')
      .send({ refreshToken: r1 })
      .expect(401);
    expect(replay.body.error.code).toBe('INVALID_TOKEN');
  });

  it('replaying a rotated token outside the grace window revokes the entire family', async () => {
    const { res } = await registerMobile();
    const r1 = res.body.refreshToken;
    await new Promise((r) => setTimeout(r, 50));

    // Rotate twice to build a chain.
    const ref1 = await api.client
      .post('/auth/refresh')
      .set('x-client', 'mobile')
      .send({ refreshToken: r1 })
      .expect(200);
    const r2 = ref1.body.refreshToken;
    await new Promise((r) => setTimeout(r, 50));
    const ref2 = await api.client
      .post('/auth/refresh')
      .set('x-client', 'mobile')
      .send({ refreshToken: r2 })
      .expect(200);
    const r3 = ref2.body.refreshToken;

    // Force-mark the old refresh row as if its replacedAt was 11s ago,
    // bypassing the grace window. Then replay r1 → reuse detected →
    // family killed → r3 (current valid token) also dies.
    const { Client } = await import('pg');
    // Superuser connection required — this test simulates a grace-window
    // expiry by UPDATEing RefreshToken directly, bypassing RLS. Read from
    // the env var so the test is portable across developer machines.
    const c = new Client({
      connectionString:
        process.env['MIGRATION_DATABASE_URL'] ??
        'postgresql://postgres@localhost:5432/agent_saas_test',
    });
    await c.connect();
    try {
      await c.query(
        `UPDATE "RefreshToken" SET "replacedAt" = now() - interval '15 seconds' WHERE "tokenHash" IS NOT NULL`,
      );
    } finally {
      await c.end();
    }

    const reuse = await api.client
      .post('/auth/refresh')
      .set('x-client', 'mobile')
      .send({ refreshToken: r1 })
      .expect(401);
    expect(reuse.body.error.message).toMatch(/reuse detected|session revoked/i);

    // r3 (the latest valid token) should now fail because the family was killed.
    await api.client
      .post('/auth/refresh')
      .set('x-client', 'mobile')
      .send({ refreshToken: r3 })
      .expect(401);
  });

  // ── Sessions ───────────────────────────────────────────────────

  it('GET /auth/sessions lists active session families', async () => {
    const { res } = await registerMobile();
    const access = res.body.accessToken;

    const list = await api.client
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${access}`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].familyId).toBeDefined();
  });

  it('DELETE /auth/sessions/:familyId revokes that session only', async () => {
    const { res } = await registerMobile();
    const access = res.body.accessToken;
    const refresh = res.body.refreshToken;

    const list = await api.client
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${access}`)
      .expect(200);
    const familyId = list.body[0].familyId;

    await api.client
      .delete(`/auth/sessions/${familyId}`)
      .set('Authorization', `Bearer ${access}`)
      .expect(200);

    // Refresh now fails — family revoked.
    await api.client
      .post('/auth/refresh')
      .set('x-client', 'mobile')
      .send({ refreshToken: refresh })
      .expect(401);
  });
});
