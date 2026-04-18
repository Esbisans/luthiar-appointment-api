import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

describe('Auth (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
  });

  it('registers a new business + owner and returns tokens (mobile mode)', async () => {
    const res = await api.client
      .post('/auth/register')
      .set('x-client', 'mobile')
      .send({
        email: 'new-owner@test.dev',
        password: 'Password123!',
        name: 'New Owner',
        businessName: 'New Biz',
        slug: 'new-biz',
      })
      .expect(201);

    expect(res.body.business).toMatchObject({ name: 'New Biz', slug: 'new-biz' });
    expect(res.body.user).toMatchObject({
      email: 'new-owner@test.dev',
      role: 'OWNER',
    });
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  it('rejects duplicate email with UNIQUE_VIOLATION', async () => {
    await registerTenant(api.client, { email: 'dup@test.dev' });
    const res = await api.client
      .post('/auth/register')
      .send({
        email: 'dup@test.dev',
        password: 'Password123!',
        name: 'Other',
        businessName: 'Other',
        slug: 'other-slug',
      })
      .expect(409);
    expect(res.body.error.code).toBe('UNIQUE_VIOLATION');
  });

  it('logs in with correct credentials (mobile mode)', async () => {
    const tenant = await registerTenant(api.client);
    const res = await api.client
      .post('/auth/login')
      .set('x-client', 'mobile')
      .send({ email: tenant.email, password: 'Password123!' })
      .expect(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it('rejects login with wrong password', async () => {
    const tenant = await registerTenant(api.client);
    const res = await api.client
      .post('/auth/login')
      .send({ email: tenant.email, password: 'bad-password' })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects login with unknown email', async () => {
    const res = await api.client
      .post('/auth/login')
      .send({ email: 'nobody@test.dev', password: 'whatever' })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refresh issues new tokens (mobile mode)', async () => {
    const tenant = await registerTenant(api.client);
    await new Promise((r) => setTimeout(r, 1_100));
    const res = await api.client
      .post('/auth/refresh')
      .set('x-client', 'mobile')
      .send({ refreshToken: tenant.refreshToken })
      .expect(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.accessToken).not.toBe(tenant.accessToken);
    // New refresh token must differ — rotation happened.
    expect(res.body.refreshToken).not.toBe(tenant.refreshToken);
  });

  it('rejects missing body with validation error', async () => {
    const res = await api.client.post('/auth/register').send({}).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('GET /auth/me returns current user + business with valid JWT', async () => {
    const tenant = await registerTenant(api.client);
    const res = await api.client
      .get('/auth/me')
      .set('Authorization', bearer(tenant))
      .expect(200);
    expect(res.body.user).toMatchObject({
      id: tenant.userId,
      email: tenant.email,
      role: 'OWNER',
    });
    expect(res.body.business).toMatchObject({
      id: tenant.businessId,
      slug: tenant.slug,
    });
    // Tokens MUST NOT be echoed on this endpoint — same shape as login
    // minus the tokens.
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
  });

  it('GET /auth/me rejects unauthenticated requests', async () => {
    const res = await api.client.get('/auth/me').expect(401);
    expect(res.body.error.code).toMatch(/INVALID_TOKEN|FORBIDDEN/);
  });
});
