import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

/**
 * Verifies Stripe-style test/live partition.
 *
 *   agnt_test_* key → isTest=true   rows
 *   agnt_live_* key → isTest=false  rows
 *
 * The two planes never cross-read (RLS primary, Prisma extension
 * secondary). Catalog data (Service, Staff, BusinessHour) stays shared
 * — test agents book against the real service catalog.
 */
describe('Test mode partition (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  async function seed() {
    const owner = await registerTenant(api.client);
    const liveKey = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(owner))
      .send({ name: 'live', mode: 'live' })
      .expect(201);
    const testKey = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(owner))
      .send({ name: 'test', mode: 'test' })
      .expect(201);
    expect(liveKey.body.key.startsWith('agnt_live_')).toBe(true);
    expect(testKey.body.key.startsWith('agnt_test_')).toBe(true);
    return { owner, liveKey: liveKey.body.key, testKey: testKey.body.key };
  }

  it('test agent writes land in the test partition and are invisible to live agents', async () => {
    const { liveKey, testKey } = await seed();

    // Test agent creates a conversation.
    const testConv = await api.client
      .post('/conversations')
      .set('x-api-key', testKey)
      .send({ channel: 'VOICE' })
      .expect(201);
    expect(testConv.body.isTest).toBe(true);

    // Live agent listing conversations: does NOT see the test row.
    const liveList = await api.client
      .get('/conversations')
      .set('x-api-key', liveKey)
      .expect(200);
    expect(liveList.body.data).toHaveLength(0);

    // Test agent sees its own row.
    const testList = await api.client
      .get('/conversations')
      .set('x-api-key', testKey)
      .expect(200);
    expect(testList.body.data).toHaveLength(1);
    expect(testList.body.data[0].id).toBe(testConv.body.id);
  });

  it('live customer and test customer with the same phone coexist independently', async () => {
    const { liveKey, testKey } = await seed();
    const phone = '+525598760001';

    const liveRes = await api.client
      .post('/customers/find-or-create')
      .set('x-api-key', liveKey)
      .send({ phone, name: 'Ana Live' })
      .expect(201);
    const testRes = await api.client
      .post('/customers/find-or-create')
      .set('x-api-key', testKey)
      .send({ phone, name: 'Ana Test' })
      .expect(201);

    const liveId = liveRes.body.customer?.id ?? liveRes.body.id;
    const testId = testRes.body.customer?.id ?? testRes.body.id;
    expect(liveId).toBeDefined();
    expect(testId).toBeDefined();
    expect(liveId).not.toBe(testId);
    const liveIsTest = liveRes.body.customer?.isTest ?? liveRes.body.isTest;
    const testIsTest = testRes.body.customer?.isTest ?? testRes.body.isTest;
    expect(liveIsTest).toBe(false);
    expect(testIsTest).toBe(true);
  });

  it('JWT owner defaults to live mode — sees live data, not test', async () => {
    const { owner, testKey } = await seed();

    await api.client
      .post('/conversations')
      .set('x-api-key', testKey)
      .send({ channel: 'VOICE' })
      .expect(201);

    const list = await api.client
      .get('/conversations')
      .set('Authorization', bearer(owner))
      .expect(200);
    expect(list.body.data).toHaveLength(0); // live mode, no test rows visible
  });

  it('catalog data (services, staff) is shared between live and test', async () => {
    const { owner, testKey } = await seed();

    // Owner (live) creates a service.
    const svc = await api.client
      .post('/services')
      .set('Authorization', bearer(owner))
      .send({ name: 'Consulta', duration: 30, price: 500 })
      .expect(201);

    // Test agent reads the same catalog.
    const list = await api.client
      .get('/services')
      .set('x-api-key', testKey)
      .expect(200);
    const ids = list.body.data?.map((s: { id: string }) => s.id) ?? list.body.map?.((s: { id: string }) => s.id);
    expect(ids).toContain(svc.body.id);
  });
});
