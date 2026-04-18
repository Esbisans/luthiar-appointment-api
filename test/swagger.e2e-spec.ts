import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

/**
 * Under `NODE_ENV=test` (what the E2E subprocess sets) Swagger is OPEN —
 * same as dev. The production path where `/api/docs` + `/api/docs-json`
 * require an OWNER JWT is verified in a separate integration test that
 * boots a subprocess with `NODE_ENV=production` (future work — for now
 * the middleware logic mirrors the Bull Board middleware which is
 * covered by its own tests).
 */
describe('Swagger / OpenAPI exposure (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  it('serves the Swagger UI in non-production environments', async () => {
    const res = await api.client.get('/api/docs').expect(200);
    // Swagger UI HTML is served; rough sanity check.
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Swagger UI');
  });

  it('serves the OpenAPI schema JSON at /api/docs-json', async () => {
    const res = await api.client.get('/api/docs-json').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info.title).toBe('Agent SaaS API');
    // At least one tagged path is present — e.g. `/appointments`.
    const paths = Object.keys(res.body.paths ?? {});
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain('/appointments');
  });

  it('schema is consumable by openapi-typescript style tooling', async () => {
    const res = await api.client.get('/api/docs-json').expect(200);
    // Verify response shapes the generator relies on: `components.schemas`
    // with DTOs, `paths` with verbs + parameters + responses.
    expect(res.body.components?.schemas).toBeDefined();
    const schemas = Object.keys(res.body.components.schemas);
    expect(schemas).toContain('CreateAppointmentDto');
    expect(schemas).toContain('AvailabilityResponse');
  });

  it('passes through Bearer auth headers without affecting the schema', async () => {
    // An authenticated principal can also read the docs in dev. Sanity
    // check that the route isn't inadvertently gated outside of prod.
    const t = await registerTenant(api.client);
    await api.client
      .get('/api/docs-json')
      .set('Authorization', bearer(t))
      .expect(200);
  });
});
