import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

/**
 * Verifies that correlation headers propagate end-to-end. Logs are not
 * inspected here (LOG_LEVEL=silent in .env.test); we assert on response
 * headers and successful auth flow with API-key callers.
 */
describe('Observability (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  it('echoes X-Request-Id back if the caller provides it', async () => {
    const t = await registerTenant(api.client);
    const reqId = 'req-test-12345';
    const res = await api.client
      .get('/services')
      .set('Authorization', bearer(t))
      .set('X-Request-Id', reqId)
      .expect(200);
    expect(res.headers['x-request-id']).toBe(reqId);
  });

  it('mints a ULID X-Request-Id when caller omits it', async () => {
    const t = await registerTenant(api.client);
    const res = await api.client
      .get('/services')
      .set('Authorization', bearer(t))
      .expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('echoes a valid W3C traceparent back', async () => {
    const t = await registerTenant(api.client);
    const traceparent =
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const res = await api.client
      .get('/services')
      .set('Authorization', bearer(t))
      .set('traceparent', traceparent)
      .expect(200);
    expect(res.headers['traceparent']).toBe(traceparent);
  });

  it('drops malformed traceparent silently (no echo)', async () => {
    const t = await registerTenant(api.client);
    const res = await api.client
      .get('/services')
      .set('Authorization', bearer(t))
      .set('traceparent', 'not-a-valid-traceparent')
      .expect(200);
    expect(res.headers['traceparent']).toBeUndefined();
  });

  it('accepts X-Voice-Call-Id and X-Session-Id without affecting the response', async () => {
    const t = await registerTenant(api.client);
    // Smoke test: the headers don't break the request. Their effect is
    // log enrichment (verified manually with LOG_LEVEL=info).
    await api.client
      .get('/services')
      .set('Authorization', bearer(t))
      .set('X-Voice-Call-Id', 'lk-room-abc-123')
      .set('X-Session-Id', 'sess-xyz-9')
      .expect(200);
  });

  it('rejects header values with characters outside the allowlist', async () => {
    // Node's HTTP layer rejects newlines at the wire, but HTML-meta /
    // shell chars pass through and could pollute a structured-log
    // pipeline. Server falls through to ULID generation.
    const t = await registerTenant(api.client);
    const evil = 'foo<script>alert(1)</script>';
    const res = await api.client
      .get('/services')
      .set('Authorization', bearer(t))
      .set('X-Request-Id', evil)
      .expect(200);
    expect(res.headers['x-request-id']).not.toBe(evil);
    expect(res.headers['x-request-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
