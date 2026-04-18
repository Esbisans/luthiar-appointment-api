import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

describe('Agent context (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  async function seedTenant() {
    const t = await registerTenant(api.client);
    // Provision a service + staff so the bundle has something to show.
    const svc = await api.client
      .post('/services')
      .set('Authorization', bearer(t))
      .send({ name: 'Consulta', duration: 30, price: 500, description: 'General' })
      .expect(201);
    const staff = await api.client
      .post('/staff')
      .set('Authorization', bearer(t))
      .send({ name: 'Dra. Ana' })
      .expect(201);
    await api.client
      .post(`/staff/${staff.body.id}/services`)
      .set('Authorization', bearer(t))
      .send({ serviceId: svc.body.id })
      .expect(201);
    return { tenant: t, serviceId: svc.body.id, staffId: staff.body.id };
  }

  it('returns a complete bundle with business, policy, services, staff', async () => {
    const { tenant, serviceId, staffId } = await seedTenant();
    const res = await api.client
      .get('/agent/context')
      .set('Authorization', bearer(tenant))
      .expect(200);

    expect(res.body.schemaVersion).toBe('2025-04-16');
    expect(res.body.business.id).toBe(tenant.businessId);
    expect(res.body.business.timezone).toBe('America/Mexico_City');
    expect(res.body.business.locale).toBe('es-MX');
    expect(res.body.policy.cancellationWindowHours).toBe(24);
    expect(res.body.services[0].id).toBe(serviceId);
    expect(res.body.services[0].durationMinutes).toBe(30);
    expect(res.body.services[0].priceCents).toBe(50000);
    expect(res.body.staff[0].id).toBe(staffId);
    expect(res.body.staff[0].serviceIds).toContain(serviceId);
    expect(res.body.capabilities.voice).toBe(true);
  });

  it('agent (API-key) can read its own context', async () => {
    const { tenant } = await seedTenant();
    const minted = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(tenant))
      .send({ name: 'voice-agent' })
      .expect(201);
    const res = await api.client
      .get('/agent/context')
      .set('x-api-key', minted.body.key)
      .expect(200);
    expect(res.body.business.id).toBe(tenant.businessId);
  });

  it('emits ETag + Cache-Control, and returns 304 on If-None-Match', async () => {
    const { tenant } = await seedTenant();
    const first = await api.client
      .get('/agent/context')
      .set('Authorization', bearer(tenant))
      .expect(200);
    const etag = first.headers['etag'];
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
    expect(first.headers['cache-control']).toContain('max-age=60');

    await api.client
      .get('/agent/context')
      .set('Authorization', bearer(tenant))
      .set('If-None-Match', etag)
      .expect(304);
  });

  it('ETag changes when underlying data changes', async () => {
    const { tenant } = await seedTenant();
    const first = await api.client
      .get('/agent/context')
      .set('Authorization', bearer(tenant))
      .expect(200);
    const etag1 = first.headers['etag'];

    // Add another service → bundle differs → ETag differs.
    await api.client
      .post('/services')
      .set('Authorization', bearer(tenant))
      .send({ name: 'Chequeo', duration: 60, price: 800 })
      .expect(201);

    const second = await api.client
      .get('/agent/context')
      .set('Authorization', bearer(tenant))
      .expect(200);
    expect(second.headers['etag']).not.toBe(etag1);
    expect(second.body.services).toHaveLength(2);
  });

  it('tenant isolation: B gets its own bundle, not A', async () => {
    const a = await seedTenant();
    const b = await registerTenant(api.client);
    const ra = await api.client
      .get('/agent/context')
      .set('Authorization', bearer(a.tenant))
      .expect(200);
    const rb = await api.client
      .get('/agent/context')
      .set('Authorization', bearer(b))
      .expect(200);
    expect(ra.body.business.id).toBe(a.tenant.businessId);
    expect(rb.body.business.id).toBe(b.businessId);
    expect(rb.body.services).toHaveLength(0);
    // Register auto-creates an OWNER staff row so the owner is bookable;
    // B sees exactly that one, never A's.
    expect(rb.body.staff.length).toBeLessThanOrEqual(1);
    const bStaffIds = rb.body.staff.map((s: { id: string }) => s.id);
    expect(bStaffIds).not.toContain(a.staffId);
  });
});
