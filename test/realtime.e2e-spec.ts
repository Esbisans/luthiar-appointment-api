import { TestApi } from './support/test-app';
import { bearer, RegisteredTenant, registerTenant } from './support/auth.helper';
import { WsClient } from './support/ws-client';

interface Fixture {
  tenant: RegisteredTenant;
  serviceId: string;
  staffId: string;
}

async function setupFixture(api: TestApi): Promise<Fixture> {
  const tenant = await registerTenant(api.client);
  const svc = await api.client
    .post('/services')
    .set('Authorization', bearer(tenant))
    .send({ name: 'Consulta', duration: 30, price: 500 })
    .expect(201);
  const staff = await api.client
    .post('/staff')
    .set('Authorization', bearer(tenant))
    .send({ name: 'Dra. Test' })
    .expect(201);
  await api.client
    .post(`/staff/${staff.body.id}/services`)
    .set('Authorization', bearer(tenant))
    .send({ serviceId: svc.body.id })
    .expect(201);
  return { tenant, serviceId: svc.body.id, staffId: staff.body.id };
}

function futureISO(daysAhead: number, hour = 10): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${hh}:${mm}`
  );
}

describe('Realtime (e2e)', () => {
  const api = new TestApi();
  const clients: WsClient[] = [];

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  afterEach(() => {
    for (const c of clients) c.close();
    clients.length = 0;
  });

  it('rejects WS connections without JWT', async () => {
    const ws = new WsClient({ token: '' });
    clients.push(ws);
    await expect(ws.connect()).rejects.toThrow();
  });

  it('rejects WS connections with invalid JWT', async () => {
    const ws = new WsClient({ token: 'not.a.valid.jwt' });
    clients.push(ws);
    await expect(ws.connect()).rejects.toThrow();
  });

  it('delivers appointment:created to connected client within 1s', async () => {
    const f = await setupFixture(api);
    const ws = new WsClient({ token: f.tenant.accessToken });
    clients.push(ws);
    await ws.connect();

    // Set up listener BEFORE triggering the event.
    const waiter = ws.waitForEvent<Record<string, unknown>>(
      'appointment:created',
      3_000,
    );

    await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525500001001' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(5, 10),
        channel: 'VOICE',
      })
      .expect(201);

    const event = await waiter;
    expect(event).toMatchObject({
      businessId: f.tenant.businessId,
      staffId: f.staffId,
      serviceId: f.serviceId,
    });
  });

  it('tenant B cannot see tenant A events', async () => {
    const a = await setupFixture(api);
    const b = await registerTenant(api.client);

    const wsB = new WsClient({ token: b.accessToken });
    clients.push(wsB);
    await wsB.connect();

    let received = false;
    wsB.socket.on('appointment:created', () => {
      received = true;
    });

    await api.client
      .post('/appointments')
      .set('Authorization', bearer(a.tenant))
      .send({
        customer: { phone: '+525500001002' },
        staffId: a.staffId,
        serviceId: a.serviceId,
        startTime: futureISO(5, 11),
        channel: 'VOICE',
      })
      .expect(201);

    // Give ~700ms for events to propagate. B must NOT receive anything.
    await new Promise((r) => setTimeout(r, 700));
    expect(received).toBe(false);
  });

  it('delivers customer:created when a customer is registered', async () => {
    const tenant = await registerTenant(api.client);
    const ws = new WsClient({ token: tenant.accessToken });
    clients.push(ws);
    await ws.connect();

    const waiter = ws.waitForEvent<Record<string, unknown>>(
      'customer:created',
      3_000,
    );

    await api.client
      .post('/customers')
      .set('Authorization', bearer(tenant))
      .send({ name: 'Ana García', phone: '+525500002001' })
      .expect(201);

    const event = await waiter;
    expect(event).toMatchObject({
      businessId: tenant.businessId,
      name: 'Ana García',
      phone: '+525500002001',
      source: 'dashboard',
    });
  });

  it('delivers customer:created from findOrCreate ONLY when actually new', async () => {
    const tenant = await registerTenant(api.client);
    const ws = new WsClient({ token: tenant.accessToken });
    clients.push(ws);
    await ws.connect();

    const waiter = ws.waitForEvent<Record<string, unknown>>(
      'customer:created',
      3_000,
    );

    // First call — must emit because customer is new.
    await api.client
      .post('/customers/find-or-create')
      .set('Authorization', bearer(tenant))
      .send({ phone: '+525500002010', name: 'Nuevo Cliente' });

    const first = await waiter;
    expect(first).toMatchObject({
      source: 'findOrCreate',
      phone: '+525500002010',
    });

    // Second call with SAME phone — no event should fire.
    let secondEmitted = false;
    ws.socket.on('customer:created', () => {
      secondEmitted = true;
    });
    await api.client
      .post('/customers/find-or-create')
      .set('Authorization', bearer(tenant))
      .send({ phone: '+525500002010' });
    await new Promise((r) => setTimeout(r, 600));
    expect(secondEmitted).toBe(false);
  });

  it('delivers customer:updated on PATCH', async () => {
    const tenant = await registerTenant(api.client);
    const ws = new WsClient({ token: tenant.accessToken });
    clients.push(ws);
    await ws.connect();

    const created = await api.client
      .post('/customers')
      .set('Authorization', bearer(tenant))
      .send({ name: 'Ana', phone: '+525500002020' })
      .expect(201);
    // Drain the customer:created event so the next assertion catches :updated.
    await ws.waitForEvent('customer:created', 3_000);

    const waiter = ws.waitForEvent<Record<string, unknown>>(
      'customer:updated',
      3_000,
    );

    await api.client
      .patch(`/customers/${created.body.id}`)
      .set('Authorization', bearer(tenant))
      .send({ notes: 'VIP' })
      .expect(200);

    const event = await waiter;
    expect(event).toMatchObject({
      customerId: created.body.id,
      businessId: tenant.businessId,
    });
  });

  it('delivers appointment:cancelled when staff/business cancels', async () => {
    const f = await setupFixture(api);
    const ws = new WsClient({ token: f.tenant.accessToken });
    clients.push(ws);
    await ws.connect();

    const appt = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525500001003' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(7, 10),
        channel: 'VOICE',
      })
      .expect(201);
    // Consume the appointment:created event so we can listen specifically
    // for appointment:cancelled next.
    await ws.waitForEvent('appointment:created', 3_000);

    const waiter = ws.waitForEvent<Record<string, unknown>>(
      'appointment:cancelled',
      3_000,
    );

    await api.client
      .post(`/appointments/${appt.body.id}/cancel`)
      .set('Authorization', bearer(f.tenant))
      .send({ reason: 'test' })
      .expect(201);

    const event = await waiter;
    expect(event).toMatchObject({
      businessId: f.tenant.businessId,
      appointmentId: appt.body.id,
    });
  });
});
