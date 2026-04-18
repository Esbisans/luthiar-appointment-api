import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

/**
 * Verifies that payloads over Express's default 100 KB body-parser limit
 * surface as a proper HTTP 413 with code `PAYLOAD_TOO_LARGE` and
 * actionable details (limit + received bytes), not a generic 500.
 *
 * This is our contract with the frontend: a 413 means "the request was
 * too big, don't blindly retry". TanStack Query retries by default; a
 * 500 would trigger retries that keep failing.
 */
describe('Payload too large (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
  });

  it('returns 413 with PAYLOAD_TOO_LARGE code when the body exceeds the limit', async () => {
    const t = await registerTenant(api.client);
    // Build a payload ~200 KB — well over the default 100kb limit.
    const bigNotes = 'x'.repeat(200_000);
    const res = await api.client
      .post('/customers')
      .set('Authorization', bearer(t))
      .send({
        name: 'Maria',
        phone: '+525512345999',
        notes: bigNotes,
      })
      .expect(413);

    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body.error.message).toBe('Request body too large');
    // Details carry the limit so the frontend can show "max N KB, you sent M KB"
    expect(res.body.error.details).toBeDefined();
    expect(typeof res.body.error.details.limitBytes).toBe('number');
    expect(typeof res.body.error.details.receivedBytes).toBe('number');
    expect(res.body.error.details.receivedBytes).toBeGreaterThan(
      res.body.error.details.limitBytes,
    );
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('normal-size payloads are unaffected', async () => {
    const t = await registerTenant(api.client);
    await api.client
      .post('/customers')
      .set('Authorization', bearer(t))
      .send({
        name: 'Pedro',
        phone: '+525512345998',
        notes: 'short note',
      })
      .expect(201);
  });
});
