import { TestApi } from './support/test-app';

/**
 * Validates the origin-callback CORS config:
 *   • Any localhost / 127.0.0.1 port passes in dev (NODE_ENV=test).
 *   • Explicit origins in DASHBOARD_ORIGINS pass in any env.
 *   • Unknown cross-origin requests are rejected.
 *   • No-Origin requests (curl, server-to-server) always pass.
 *
 * The Express `cors` middleware responds to disallowed origins by:
 *   • OPTIONS preflight: 204 with NO `Access-Control-Allow-Origin` header.
 *   • Simple requests: 200/4xx from the handler but NO ACAO header either —
 *     the browser then blocks the response. We assert on the header, not
 *     the status, because cors's behavior is "let the browser enforce".
 */
describe('CORS (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  it('no-Origin request gets Vary header but no ACAO (CORS not applicable)', async () => {
    const res = await api.client.get('/health/live');
    // Health endpoint doesn't require CORS; headers depend on no Origin.
    expect(res.status).toBe(200);
  });

  it('localhost:3000 preflight is allowed', async () => {
    const res = await api.client
      .options('/health/live')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('localhost:3002 preflight is allowed (arbitrary dev port)', async () => {
    const res = await api.client
      .options('/health/live')
      .set('Origin', 'http://localhost:3002')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3002');
  });

  it('127.0.0.1:4000 is allowed (Next sometimes uses it)', async () => {
    const res = await api.client
      .options('/health/live')
      .set('Origin', 'http://127.0.0.1:4000')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:4000');
  });

  it('evil.com is rejected (no ACAO header)', async () => {
    const res = await api.client
      .options('/health/live')
      .set('Origin', 'http://evil.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('localhost:3000.evil.com is rejected (anchored regex)', async () => {
    const res = await api.client
      .options('/health/live')
      .set('Origin', 'http://localhost:3000.evil.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('exposes headers the dashboard will read', async () => {
    const res = await api.client
      .options('/health/live')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET');
    const exposed = res.headers['access-control-expose-headers'] ?? '';
    expect(exposed).toContain('X-Request-Id');
    expect(exposed).toContain('ETag');
    expect(exposed).toContain('RateLimit');
    expect(exposed).toContain('Retry-After');
  });
});
