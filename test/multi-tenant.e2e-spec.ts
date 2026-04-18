import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

describe('Multi-tenant isolation (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
  });

  it('tenant B cannot list tenant A services', async () => {
    const a = await registerTenant(api.client);
    const b = await registerTenant(api.client);

    // A creates a service
    await api.client
      .post('/services')
      .set('Authorization', bearer(a))
      .send({ name: 'A Service', duration: 30, price: 500 })
      .expect(201);

    // B sees zero services
    const listB = await api.client
      .get('/services')
      .set('Authorization', bearer(b))
      .expect(200);
    expect(listB.body.total).toBe(0);

    // A still sees theirs
    const listA = await api.client
      .get('/services')
      .set('Authorization', bearer(a))
      .expect(200);
    expect(listA.body.total).toBe(1);
  });

  it('tenant B cannot access tenant A resource by id (404)', async () => {
    const a = await registerTenant(api.client);
    const b = await registerTenant(api.client);

    const created = await api.client
      .post('/services')
      .set('Authorization', bearer(a))
      .send({ name: 'Private', duration: 30, price: 100 })
      .expect(201);

    // B tries to read A's service → 404 (RLS hides it, looks like not-found)
    await api.client
      .get(`/services/${created.body.id}`)
      .set('Authorization', bearer(b))
      .expect(404);

    // B tries to update A's service → 404
    await api.client
      .patch(`/services/${created.body.id}`)
      .set('Authorization', bearer(b))
      .send({ price: 999 })
      .expect(404);

    // B tries to delete A's service → 404
    await api.client
      .delete(`/services/${created.body.id}`)
      .set('Authorization', bearer(b))
      .expect(404);
  });

  it('unauthenticated requests are rejected', async () => {
    const res = await api.client.get('/services').expect(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});
