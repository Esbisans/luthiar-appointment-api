import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';
import type { RegisteredTenant } from './support/auth.helper';

async function seedTenant(api: TestApi, slotIntervalMin = 15) {
  const t = await registerTenant(api.client);
  const svc = await api.client
    .post('/services')
    .set('Authorization', bearer(t))
    .send({ name: 'Consulta', duration: 30, price: 500, slotIntervalMin })
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

async function seedBusinessHours(api: TestApi, t: RegisteredTenant) {
  // Open Mon–Sun 08:00-20:00 (generous so test times always land inside).
  const days = [
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
    'SUNDAY',
  ];
  await api.client
    .put('/business-hours')
    .set('Authorization', bearer(t))
    .send({
      items: days.map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '08:00',
        endTime: '20:00',
        isOpen: true,
      })),
    })
    .expect(200);
}

function isoAtLocalWithOffset(daysAhead: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, minute, 0, 0);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${hh}:${mm}`;
}

describe('Clock skew + slot boundary (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  // ── Clock skew tolerance ──────────────────────────────────────────

  it('accepts startTime 10 seconds in the past (within skew window)', async () => {
    const f = await seedTenant(api);
    // Build an ISO for exactly 10s ago. No business hours seeded so the
    // slot-grid check is soft-skipped — this isolates the skew behavior.
    const past = new Date(Date.now() - 10_000);
    const iso = past.toISOString();
    await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345501' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: iso,
        channel: 'VOICE',
      })
      .expect(201);
  });

  it('rejects startTime 45 seconds in the past (outside skew window)', async () => {
    const f = await seedTenant(api);
    const past = new Date(Date.now() - 45_000);
    const res = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345502' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: past.toISOString(),
        channel: 'VOICE',
      })
      .expect(422);
    expect(res.body.error.details?.[0]?.code).toBe('past');
  });

  // ── Slot boundary ────────────────────────────────────────────────

  it('no business hours configured → slot-boundary check is soft-skipped', async () => {
    const f = await seedTenant(api, 15);
    // Tenant has no business_hours seeded — backwards compat: accept any
    // aligned or misaligned time.
    const res = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345510' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: isoAtLocalWithOffset(3, 10, 17), // 10:17 AM — off-grid
        channel: 'VOICE',
      })
      .expect(201);
    expect(res.body.status).toBe('PENDING');
  });

  it('business hours + on-boundary startTime → accepted', async () => {
    const f = await seedTenant(api, 15);
    await seedBusinessHours(api, f.tenant);
    await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345520' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: isoAtLocalWithOffset(3, 10, 15), // 10:15 — on 15-min grid from 08:00
        channel: 'VOICE',
      })
      .expect(201);
  });

  it('business hours + off-boundary startTime → 422 slot_boundary_mismatch', async () => {
    const f = await seedTenant(api, 15);
    await seedBusinessHours(api, f.tenant);
    const res = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345521' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: isoAtLocalWithOffset(3, 10, 17), // 10:17 — NOT on 15-min grid
        channel: 'VOICE',
      })
      .expect(422);
    expect(res.body.error.details?.[0]?.code).toBe('slot_boundary_mismatch');
    // Message surfaces nearest valid slots.
    expect(res.body.error.details?.[0]?.message).toMatch(/10:15|10:30/);
  });

  it('custom slot grid (5-min) accepts 10:05, rejects 10:07', async () => {
    const f = await seedTenant(api, 5);
    await seedBusinessHours(api, f.tenant);

    await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345530' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: isoAtLocalWithOffset(4, 10, 5),
        channel: 'VOICE',
      })
      .expect(201);

    const bad = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345531' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: isoAtLocalWithOffset(4, 10, 7),
        channel: 'VOICE',
      })
      .expect(422);
    expect(bad.body.error.details?.[0]?.code).toBe('slot_boundary_mismatch');
  });

  it('startTime outside business hours → 422 outside_business_hours', async () => {
    const f = await seedTenant(api, 15);
    await seedBusinessHours(api, f.tenant);
    // 06:30 — business opens at 08:00. Tenant configured their
    // schedule; we must honour it and reject.
    const res = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345540' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: isoAtLocalWithOffset(5, 6, 30),
        channel: 'VOICE',
      })
      .expect(422);
    expect(res.body.error.details?.[0]?.code).toBe('outside_business_hours');
    expect(res.body.error.details?.[0]?.message).toMatch(/08:00|20:00/);
  });

  it('day of week closed → 422 business_closed', async () => {
    const f = await seedTenant(api, 15);
    // Configure only Mon-Fri open; Sat/Sun left out.
    await api.client
      .put('/business-hours')
      .set('Authorization', bearer(f.tenant))
      .send({
        items: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map(
          (dayOfWeek) => ({
            dayOfWeek,
            startTime: '08:00',
            endTime: '20:00',
            isOpen: true,
          }),
        ),
      })
      .expect(200);

    // Find the next Sunday for the test. UTC weekday 0 = Sunday.
    const candidate = new Date();
    for (let i = 1; i < 14; i++) {
      candidate.setDate(candidate.getDate() + 1);
      if (candidate.getDay() === 0) break;
    }
    candidate.setHours(10, 0, 0, 0);
    const off = -candidate.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    const hh = String(Math.floor(a / 60)).padStart(2, '0');
    const mm = String(a % 60).padStart(2, '0');
    const pad = (n: number) => String(n).padStart(2, '0');
    const sundayIso = `${candidate.getFullYear()}-${pad(candidate.getMonth() + 1)}-${pad(candidate.getDate())}T${pad(candidate.getHours())}:${pad(candidate.getMinutes())}:00${sign}${hh}:${mm}`;

    const res = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345541' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: sundayIso,
        channel: 'VOICE',
      })
      .expect(422);
    expect(res.body.error.details?.[0]?.code).toBe('business_closed');
  });
});
