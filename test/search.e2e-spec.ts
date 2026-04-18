import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

function futureISO(daysAhead: number, hour = 10): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  const off = -d.getTimezoneOffset();
  const s = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${s}${hh}:${mm}`;
}

describe('Global search (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  it('finds a customer by partial name', async () => {
    const t = await registerTenant(api.client);
    await api.client
      .post('/customers')
      .set('Authorization', bearer(t))
      .send({ name: 'Maria García', phone: '+525599990001' })
      .expect(201);
    await api.client
      .post('/customers')
      .set('Authorization', bearer(t))
      .send({ name: 'Pedro López', phone: '+525599990002' })
      .expect(201);

    const res = await api.client
      .get('/search?q=Mari')
      .set('Authorization', bearer(t))
      .expect(200);

    expect(res.body.results.customers).toHaveLength(1);
    expect(res.body.results.customers[0].title).toBe('Maria García');
    expect(res.body.took_ms).toBeGreaterThanOrEqual(0);
  });

  it('is accent-insensitive (Josefína ≈ Josefina)', async () => {
    const t = await registerTenant(api.client);
    await api.client
      .post('/customers')
      .set('Authorization', bearer(t))
      .send({ name: 'Josefína Rodríguez', phone: '+525599991001' })
      .expect(201);
    const res = await api.client
      .get('/search?q=Josefina')
      .set('Authorization', bearer(t))
      .expect(200);
    expect(res.body.results.customers.length).toBeGreaterThan(0);
    expect(res.body.results.customers[0].title).toContain('Josefína');
  });

  it('tolerates typos (trigram similarity)', async () => {
    const t = await registerTenant(api.client);
    await api.client
      .post('/customers')
      .set('Authorization', bearer(t))
      .send({ name: 'Fernando Martínez', phone: '+525599992001' })
      .expect(201);
    const res = await api.client
      .get('/search?q=Fernndo') // missing 'a'
      .set('Authorization', bearer(t))
      .expect(200);
    expect(res.body.results.customers.length).toBeGreaterThan(0);
  });

  it('searches staff and services in the catalog', async () => {
    const t = await registerTenant(api.client);
    await api.client
      .post('/services')
      .set('Authorization', bearer(t))
      .send({ name: 'Limpieza dental', duration: 30, price: 500 })
      .expect(201);
    await api.client
      .post('/staff')
      .set('Authorization', bearer(t))
      .send({ name: 'Dra. Patricia' })
      .expect(201);

    const res = await api.client
      .get('/search?q=Patri')
      .set('Authorization', bearer(t))
      .expect(200);
    expect(res.body.results.staff.length).toBeGreaterThan(0);

    const res2 = await api.client
      .get('/search?q=limpieza')
      .set('Authorization', bearer(t))
      .expect(200);
    expect(res2.body.results.services.length).toBeGreaterThan(0);
  });

  it('searches conversation summaries and message content (full-text)', async () => {
    const t = await registerTenant(api.client);
    const apiKey = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(t))
      .send({ name: 'voice', mode: 'live' })
      .expect(201);
    const conv = await api.client
      .post('/conversations')
      .set('x-api-key', apiKey.body.key)
      .send({ channel: 'VOICE' })
      .expect(201);
    await api.client
      .post(`/conversations/${conv.body.id}/messages`)
      .set('x-api-key', apiKey.body.key)
      .set('Idempotency-Key', `m-${Date.now()}-1`)
      .send({
        turnIndex: 0,
        clientTimestamp: new Date().toISOString(),
        role: 'USER',
        content: 'Quiero agendar una cita para limpieza dental el viernes',
      })
      .expect(201);
    // Give pg time to flush generated tsvector (it's synchronous but just in case).
    await new Promise((r) => setTimeout(r, 50));

    const res = await api.client
      .get('/search?q=limpieza')
      .set('Authorization', bearer(t))
      .expect(200);
    // Either conversation summary or via transcript match.
    expect(res.body.results.conversations.length).toBeGreaterThan(0);
  });

  it('supports filtering by types', async () => {
    const t = await registerTenant(api.client);
    await api.client
      .post('/customers')
      .set('Authorization', bearer(t))
      .send({ name: 'Carlos Hernández', phone: '+525599993001' })
      .expect(201);
    await api.client
      .post('/services')
      .set('Authorization', bearer(t))
      .send({ name: 'Carlos consulta' /* service name containing "Carlos" */, duration: 30, price: 500 })
      .expect(201);

    const onlyCustomers = await api.client
      .get('/search?q=Carlos&types=customer')
      .set('Authorization', bearer(t))
      .expect(200);
    expect(onlyCustomers.body.results.customers.length).toBeGreaterThan(0);
    expect(onlyCustomers.body.results.services).toHaveLength(0);
  });

  it('empty or too-short queries return empty results, not 400', async () => {
    const t = await registerTenant(api.client);
    const r1 = await api.client
      .get('/search?q=')
      .set('Authorization', bearer(t))
      .expect(200);
    expect(r1.body.results.customers).toHaveLength(0);

    const r2 = await api.client
      .get('/search?q=a')
      .set('Authorization', bearer(t))
      .expect(200);
    expect(r2.body.results.customers).toHaveLength(0);
  });

  it('tenant A cannot see tenant B rows via search (RLS isolation)', async () => {
    const a = await registerTenant(api.client);
    const b = await registerTenant(api.client);
    await api.client
      .post('/customers')
      .set('Authorization', bearer(a))
      .send({ name: 'Secret Name', phone: '+525599994001' })
      .expect(201);
    const res = await api.client
      .get('/search?q=Secret')
      .set('Authorization', bearer(b))
      .expect(200);
    expect(res.body.results.customers).toHaveLength(0);
  });

  it('respects per-type limit', async () => {
    const t = await registerTenant(api.client);
    for (let i = 0; i < 7; i++) {
      await api.client
        .post('/customers')
        .set('Authorization', bearer(t))
        .send({ name: `Maria #${i}`, phone: `+52559995000${i}` })
        .expect(201);
    }
    const res = await api.client
      .get('/search?q=Maria&limit=3')
      .set('Authorization', bearer(t))
      .expect(200);
    expect(res.body.results.customers).toHaveLength(3);
  });

  // Used by an ignore-decorator style — skip if the field is unused in
  // the test (the `_api` variable is silenced by the linter this way).
  void api;
});
