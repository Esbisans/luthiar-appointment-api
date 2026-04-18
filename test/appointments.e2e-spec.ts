import { TestApi } from './support/test-app';
import { bearer, RegisteredTenant, registerTenant } from './support/auth.helper';

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

describe('Appointments (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  it('creates an appointment with inline customer (find-or-create)', async () => {
    const f = await setupFixture(api);
    const res = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345001', name: 'Ana' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(5, 10),
        channel: 'VOICE',
      })
      .expect(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.staffId).toBe(f.staffId);
  });

  it('double-booking the same slot is rejected by EXCLUDE (409)', async () => {
    const f = await setupFixture(api);
    const start = futureISO(5, 10);
    await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345002' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: start,
        channel: 'VOICE',
      })
      .expect(201);
    const second = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345003' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: start,
        channel: 'WEB_CHAT',
      })
      .expect(409);
    expect(second.body.error.code).toBe('CONFLICT');
    expect(second.body.error.message).toMatch(/already taken/i);
  });

  it('cancel + reschedule state machine', async () => {
    const f = await setupFixture(api);
    const a = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345004' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(7, 9),
        channel: 'VOICE',
      })
      .expect(201);
    // confirm → check-in → complete
    await api.client.post(`/appointments/${a.body.id}/confirm`).set('Authorization', bearer(f.tenant)).expect(201);
    await api.client.post(`/appointments/${a.body.id}/check-in`).set('Authorization', bearer(f.tenant)).expect(201);
    await api.client.post(`/appointments/${a.body.id}/complete`).set('Authorization', bearer(f.tenant)).expect(201);

    // terminal → cancel rejected
    const rejected = await api.client
      .post(`/appointments/${a.body.id}/cancel`)
      .set('Authorization', bearer(f.tenant))
      .send({ reason: 'test' })
      .expect(409);
    expect(rejected.body.error.code).toBe('CONFLICT');
  });

  it('reschedule creates a new record linked via rescheduledFromId', async () => {
    const f = await setupFixture(api);
    const a = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345005' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(10, 10),
        channel: 'VOICE',
      })
      .expect(201);
    const rescheduled = await api.client
      .post(`/appointments/${a.body.id}/reschedule`)
      .set('Authorization', bearer(f.tenant))
      .set('Idempotency-Key', `resched-${Date.now()}`)
      .send({ startTime: futureISO(10, 15), reason: 'test' })
      .expect(201);
    expect(rescheduled.body.id).not.toBe(a.body.id);
    expect(rescheduled.body.rescheduledFromId).toBe(a.body.id);

    // Old is CANCELLED
    const old = await api.client
      .get(`/appointments/${a.body.id}`)
      .set('Authorization', bearer(f.tenant))
      .expect(200);
    expect(old.body.status).toBe('CANCELLED');
    expect(old.body.cancellationReason).toBe('test');
  });

  it('Idempotency-Key replay returns the same appointment', async () => {
    const f = await setupFixture(api);
    const key = `idem-${Date.now()}`;
    const body = {
      customer: { phone: '+525512345006' },
      staffId: f.staffId,
      serviceId: f.serviceId,
      startTime: futureISO(14, 10),
      channel: 'VOICE',
    };
    const first = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .set('Idempotency-Key', key)
      .send(body);
    expect(second.body.id).toBe(first.body.id);
  });

  it('cancel is idempotent — second call returns the same cancelled appointment', async () => {
    const f = await setupFixture(api);
    const created = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345020' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(20, 10),
        channel: 'VOICE',
      })
      .expect(201);
    const key = `cancel-${Date.now()}`;
    const first = await api.client
      .post(`/appointments/${created.body.id}/cancel`)
      .set('Authorization', bearer(f.tenant))
      .set('Idempotency-Key', key)
      .send({ reason: 'voice retry test' })
      .expect(201);
    const second = await api.client
      .post(`/appointments/${created.body.id}/cancel`)
      .set('Authorization', bearer(f.tenant))
      .set('Idempotency-Key', key)
      .send({ reason: 'voice retry test' })
      .expect(201);
    expect(second.body).toEqual(first.body);
    expect(second.body.status).toBe('CANCELLED');
  });

  it('cancel without idempotency-key after already cancelled returns the cancelled state, not 409', async () => {
    // State-machine fallback: even if the agent forgot to set the
    // Idempotency-Key header (or the TTL expired), a re-cancel must NOT
    // surface a 409 — the idempotent service layer returns the current
    // cancelled appointment.
    const f = await setupFixture(api);
    const created = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345021' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(20, 11),
        channel: 'VOICE',
      })
      .expect(201);
    await api.client
      .post(`/appointments/${created.body.id}/cancel`)
      .set('Authorization', bearer(f.tenant))
      .send({ reason: 'first' })
      .expect(201);
    const second = await api.client
      .post(`/appointments/${created.body.id}/cancel`)
      .set('Authorization', bearer(f.tenant))
      .send({ reason: 'second' })
      .expect(201);
    expect(second.body.status).toBe('CANCELLED');
  });

  it('confirm is idempotent under retry', async () => {
    const f = await setupFixture(api);
    const created = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345022' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(21, 10),
        channel: 'VOICE',
      })
      .expect(201);
    const key = `confirm-${Date.now()}`;
    const first = await api.client
      .post(`/appointments/${created.body.id}/confirm`)
      .set('Authorization', bearer(f.tenant))
      .set('Idempotency-Key', key)
      .expect(201);
    const second = await api.client
      .post(`/appointments/${created.body.id}/confirm`)
      .set('Authorization', bearer(f.tenant))
      .set('Idempotency-Key', key)
      .expect(201);
    expect(second.body).toEqual(first.body);
    expect(second.body.status).toBe('CONFIRMED');
  });

  it('Idempotency-Key with different body returns 422', async () => {
    const f = await setupFixture(api);
    const key = `idem-mismatch-${Date.now()}`;
    const baseBody = {
      customer: { phone: '+525512345007' },
      staffId: f.staffId,
      serviceId: f.serviceId,
      startTime: futureISO(14, 11),
      channel: 'VOICE',
    };
    await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .set('Idempotency-Key', key)
      .send(baseBody)
      .expect(201);
    const res = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .set('Idempotency-Key', key)
      .send({ ...baseBody, startTime: futureISO(14, 12) })
      .expect(422);
    expect(res.body.error.details[0].code).toBe('mismatch');
  });

  it('rejects booking in the past', async () => {
    const f = await setupFixture(api);
    const res = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345008' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: '2020-01-01T10:00:00-06:00',
        channel: 'VOICE',
      })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
