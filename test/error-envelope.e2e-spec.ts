import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

/**
 * Verifies the additive RFC 9457 fields (`type`, `title`) on the error
 * envelope while keeping the existing `code`, `message`, `status`,
 * `details`, `traceId`, `timestamp` keys for backwards compat.
 *
 * The URN format `urn:agent-saas:problems:<kebab-code>` is honest about
 * being a stable identifier, not a clickable URL — switches to a real
 * documentation URL when the public API + docs site lands (D86).
 */
describe('Error envelope (RFC 9457 additive)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
  });

  it('422 validation error includes type URN + title + code', async () => {
    const t = await registerTenant(api.client);
    const res = await api.client
      .post('/services')
      .set('Authorization', bearer(t))
      .send({}) // missing required `name`, `duration`, `price`
      .expect(422);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.error.type).toBe('urn:agent-saas:problems:validation-failed');
    expect(res.body.error.title).toBe('Unprocessable Entity');
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.status).toBe(422);
    expect(res.body.error.message).toBeDefined();
    expect(res.body.error.traceId).toBeDefined();
    expect(res.body.error.timestamp).toBeDefined();
  });

  it('404 not found includes the right URN + title', async () => {
    const t = await registerTenant(api.client);
    const res = await api.client
      .get('/appointments/00000000-0000-0000-0000-000000000000')
      .set('Authorization', bearer(t))
      .expect(404);

    expect(res.body.error.type).toBe('urn:agent-saas:problems:not-found');
    expect(res.body.error.title).toBe('Not Found');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('401 unauthorized includes the right URN + title', async () => {
    const res = await api.client.get('/appointments').expect(401);
    expect(res.body.error.type).toMatch(/^urn:agent-saas:problems:/);
    expect(res.body.error.title).toBe('Unauthorized');
    expect(res.body.error.status).toBe(401);
  });

  it('413 payload too large includes the right URN + title', async () => {
    const t = await registerTenant(api.client);
    const big = 'x'.repeat(200_000);
    const res = await api.client
      .post('/customers')
      .set('Authorization', bearer(t))
      .send({ name: 'X', phone: '+525512349999', notes: big })
      .expect(413);

    expect(res.body.error.type).toBe('urn:agent-saas:problems:payload-too-large');
    expect(res.body.error.title).toBe('Payload Too Large');
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('preserves existing keys for backwards compat', async () => {
    const t = await registerTenant(api.client);
    const res = await api.client
      .post('/services')
      .set('Authorization', bearer(t))
      .send({})
      .expect(422);

    // All historical keys still present — no consumer breakage.
    expect(res.body.error).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
      status: expect.any(Number),
      timestamp: expect.any(String),
    });
    expect(res.body.error.traceId).toBeDefined();
    // Plus the new RFC 9457 additive fields.
    expect(res.body.error.type).toBeDefined();
    expect(res.body.error.title).toBeDefined();
  });
});
