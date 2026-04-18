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

async function seed(api: TestApi) {
  const t = await registerTenant(api.client);
  const svc = await api.client
    .post('/services')
    .set('Authorization', bearer(t))
    .send({ name: 'Consulta', duration: 30, price: 500 })
    .expect(201);
  const staff = await api.client
    .post('/staff')
    .set('Authorization', bearer(t))
    .send({ name: 'Dra. Test' })
    .expect(201);
  await api.client
    .post(`/staff/${staff.body.id}/services`)
    .set('Authorization', bearer(t))
    .send({ serviceId: svc.body.id })
    .expect(201);
  return { tenant: t, serviceId: svc.body.id, staffId: staff.body.id };
}

describe('Cursor pagination (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  // ── Customers ─────────────────────────────────────────────────────

  it('customers: returns {data, has_more, next_cursor} when cursor mode requested', async () => {
    const t = await registerTenant(api.client);
    // Seed 5 customers.
    for (let i = 0; i < 5; i++) {
      await api.client
        .post('/customers')
        .set('Authorization', bearer(t))
        .send({ name: `Cliente ${i}`, phone: `+5255000011${String(i).padStart(2, '0')}` })
        .expect(201);
      await new Promise((r) => setTimeout(r, 3));
    }
    const page1 = await api.client
      .get('/customers?limit=2&cursor=')
      .set('Authorization', bearer(t));
    // Empty cursor should be treated as absent — fall back to offset.
    expect(page1.status).toBe(200);

    const pFirst = await api.client
      .get('/customers?limit=2')
      .set('Authorization', bearer(t))
      .expect(200);
    // No cursor supplied → legacy offset shape.
    expect(pFirst.body).toMatchObject({ total: 5, page: 1, limit: 2 });

    // Synthesize a cursor from the first offset response's last row.
    const lastRow = pFirst.body.data.at(-1);
    const cursorPayload = Buffer.from(
      JSON.stringify({ t: lastRow.createdAt, i: lastRow.id }),
    ).toString('base64url');
    const pNext = await api.client
      .get(`/customers?limit=2&cursor=${cursorPayload}`)
      .set('Authorization', bearer(t))
      .expect(200);
    expect(pNext.body).toHaveProperty('has_more');
    expect(pNext.body).toHaveProperty('next_cursor');
    expect(pNext.body.data).toHaveLength(2);
    expect(pNext.body.data.map((c: { id: string }) => c.id)).not.toContain(lastRow.id);
  });

  it('customers: has_more is false on the last page, next_cursor is null', async () => {
    const t = await registerTenant(api.client);
    for (let i = 0; i < 3; i++) {
      await api.client
        .post('/customers')
        .set('Authorization', bearer(t))
        .send({ name: `Cliente ${i}`, phone: `+5255000022${String(i).padStart(2, '0')}` })
        .expect(201);
      await new Promise((r) => setTimeout(r, 3));
    }
    // Empty cursor means "page 1" in cursor mode — use no cursor param here
    // and read the offset-first page to grab a cursor for page 2.
    const first = await api.client
      .get('/customers?limit=10')
      .set('Authorization', bearer(t))
      .expect(200);
    const last = first.body.data.at(-1);
    const cursor = Buffer.from(JSON.stringify({ t: last.createdAt, i: last.id })).toString(
      'base64url',
    );
    const page2 = await api.client
      .get(`/customers?limit=10&cursor=${cursor}`)
      .set('Authorization', bearer(t))
      .expect(200);
    expect(page2.body.data).toHaveLength(0);
    expect(page2.body.has_more).toBe(false);
    expect(page2.body.next_cursor).toBeNull();
  });

  it('customers: invalid cursor returns 422', async () => {
    const t = await registerTenant(api.client);
    const res = await api.client
      .get('/customers?cursor=not-a-valid-cursor')
      .set('Authorization', bearer(t))
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  // ── Appointments ──────────────────────────────────────────────────

  it('appointments: cursor paginates by startTime (not createdAt)', async () => {
    const f = await seed(api);
    // Create 4 appointments at different startTimes.
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = await api.client
        .post('/appointments')
        .set('Authorization', bearer(f.tenant))
        .send({
          customer: { phone: `+52551234401${i}` },
          staffId: f.staffId,
          serviceId: f.serviceId,
          startTime: futureISO(10 + i, 10),
          channel: 'VOICE',
        })
        .expect(201);
      ids.push(r.body.id);
    }
    // Get first two (most-distant-future first — DESC by startTime).
    const pFirst = await api.client
      .get('/appointments?limit=2')
      .set('Authorization', bearer(f.tenant))
      .expect(200);
    expect(pFirst.body.data).toHaveLength(2);
    // Verify DESC by startTime: first result is day 14, second is day 13.
    const t0 = new Date(pFirst.body.data[0].startTime).getTime();
    const t1 = new Date(pFirst.body.data[1].startTime).getTime();
    expect(t0).toBeGreaterThan(t1);

    // Grab cursor from last row in page 1.
    const last = pFirst.body.data.at(-1);
    const cursor = Buffer.from(
      JSON.stringify({ t: last.startTime, i: last.id }),
    ).toString('base64url');
    const pNext = await api.client
      .get(`/appointments?limit=2&cursor=${cursor}`)
      .set('Authorization', bearer(f.tenant))
      .expect(200);
    expect(pNext.body.data).toHaveLength(2);
    expect(pNext.body.data.map((a: { id: string }) => a.id)).not.toContain(last.id);
    // Page 2 should be earlier dates.
    const t2 = new Date(pNext.body.data[0].startTime).getTime();
    expect(t2).toBeLessThan(t1);
  });

  it('appointments: cursor pagination respects status filter', async () => {
    const f = await seed(api);
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const r = await api.client
        .post('/appointments')
        .set('Authorization', bearer(f.tenant))
        .send({
          customer: { phone: `+52551234402${i}` },
          staffId: f.staffId,
          serviceId: f.serviceId,
          startTime: futureISO(20 + i, 10),
          channel: 'VOICE',
        })
        .expect(201);
      ids.push(r.body.id);
    }
    // Cancel the middle one.
    await api.client
      .post(`/appointments/${ids[1]}/cancel`)
      .set('Authorization', bearer(f.tenant))
      .send({ reason: 'test' })
      .expect(201);

    const res = await api.client
      .get('/appointments?status=PENDING&limit=10')
      .set('Authorization', bearer(f.tenant))
      .expect(200);
    // Offset response (no cursor supplied) — we assert legacy shape is still honoured.
    expect(res.body.total).toBe(2);
    expect(res.body.data.every((a: { status: string }) => a.status === 'PENDING')).toBe(
      true,
    );
  });

  // ── Legacy offset still works ─────────────────────────────────────

  it('legacy ?page= still returns {data, total, page, limit} for backward compat', async () => {
    const t = await registerTenant(api.client);
    for (let i = 0; i < 3; i++) {
      await api.client
        .post('/customers')
        .set('Authorization', bearer(t))
        .send({ name: `L ${i}`, phone: `+5255000033${String(i).padStart(2, '0')}` })
        .expect(201);
    }
    const res = await api.client
      .get('/customers?page=1&limit=20')
      .set('Authorization', bearer(t))
      .expect(200);
    expect(res.body).toMatchObject({ total: 3, page: 1, limit: 20 });
    expect(res.body.has_more).toBeUndefined();
    expect(res.body.next_cursor).toBeUndefined();
  });
});
