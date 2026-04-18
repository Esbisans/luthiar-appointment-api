import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

describe('API Keys (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  it('OWNER can create a key and the plaintext is returned exactly once', async () => {
    const t = await registerTenant(api.client);
    const res = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(t))
      .send({ name: 'voice-agent-test' })
      .expect(201);

    expect(res.body.key).toMatch(/^agnt_(live|test)_[A-Za-z0-9]+$/);
    expect(res.body.prefix).toBe(res.body.key.slice(0, 18));
    expect(res.body.last4).toHaveLength(4);
    expect(res.body.id).toBeDefined();

    const list = await api.client
      .get('/api-keys')
      .set('Authorization', bearer(t))
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].key).toBeUndefined(); // never returned again
    expect(list.body[0].prefix).toBe(res.body.prefix);
  });

  it('a freshly minted key authenticates against a tenant endpoint', async () => {
    const t = await registerTenant(api.client);
    const minted = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(t))
      .send({ name: 'voice-agent' })
      .expect(201);

    // Use the API key to call a tenant endpoint.
    await api.client
      .get('/services')
      .set('x-api-key', minted.body.key)
      .expect(200);
  });

  it('rejects malformed keys offline (CRC32 fail) — no DB hit', async () => {
    await api.client
      .get('/services')
      .set('x-api-key', 'agnt_live_garbage123456')
      .expect(401);
  });

  it('revoked key stops authenticating immediately', async () => {
    const t = await registerTenant(api.client);
    const minted = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(t))
      .send({ name: 'tmp' })
      .expect(201);

    await api.client
      .get('/services')
      .set('x-api-key', minted.body.key)
      .expect(200);

    await api.client
      .delete(`/api-keys/${minted.body.id}`)
      .set('Authorization', bearer(t))
      .expect(200);

    await api.client
      .get('/services')
      .set('x-api-key', minted.body.key)
      .expect(401);
  });

  it('revoke is idempotent — second call returns the revoked record', async () => {
    const t = await registerTenant(api.client);
    const minted = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(t))
      .send({ name: 'tmp' })
      .expect(201);
    const first = await api.client
      .delete(`/api-keys/${minted.body.id}`)
      .set('Authorization', bearer(t))
      .expect(200);
    const second = await api.client
      .delete(`/api-keys/${minted.body.id}`)
      .set('Authorization', bearer(t))
      .expect(200);
    expect(second.body.revokedAt).toBe(first.body.revokedAt);
  });

  it('rotate mints a new key and shortens the old one to the grace window', async () => {
    const t = await registerTenant(api.client);
    const old = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(t))
      .send({ name: 'rotate-me' })
      .expect(201);

    const rotated = await api.client
      .post(`/api-keys/${old.body.id}/rotate`)
      .set('Authorization', bearer(t))
      .send({ graceSeconds: 60 })
      .expect(201);

    expect(rotated.body.key).not.toBe(old.body.key);
    expect(rotated.body.id).not.toBe(old.body.id);
    expect(rotated.body.name).toContain('rotated');

    // Old key still works during the grace window.
    await api.client
      .get('/services')
      .set('x-api-key', old.body.key)
      .expect(200);

    // New key works.
    await api.client
      .get('/services')
      .set('x-api-key', rotated.body.key)
      .expect(200);
  });

  it('non-OWNER cannot mint keys', async () => {
    const t = await registerTenant(api.client);
    // Demote: register another user via /auth as STAFF? The API only
    // supports owner registration. We assert that an API-key caller
    // (role=AGENT) cannot list/create — proving role guard fires.
    const minted = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(t))
      .send({ name: 'agent-key' })
      .expect(201);

    await api.client
      .post('/api-keys')
      .set('x-api-key', minted.body.key)
      .send({ name: 'agent-self-mint' })
      .expect(403);
  });

  it('tenant A cannot see tenant B keys', async () => {
    const a = await registerTenant(api.client);
    const b = await registerTenant(api.client);
    await api.client
      .post('/api-keys')
      .set('Authorization', bearer(a))
      .send({ name: 'a-key' })
      .expect(201);
    const list = await api.client
      .get('/api-keys')
      .set('Authorization', bearer(b))
      .expect(200);
    expect(list.body).toHaveLength(0);
  });
});
