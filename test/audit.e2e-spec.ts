import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

async function fixture(api: TestApi) {
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

function futureISO(days: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${hh}:${mm}`;
}

describe('Audit (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  it('appointment.created writes an audit row', async () => {
    const f = await fixture(api);
    const appt = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345030' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(5, 10),
        channel: 'VOICE',
      })
      .expect(201);
    // Give the after-commit hook a tick.
    await new Promise((r) => setTimeout(r, 50));

    const audit = await api.client
      .get(`/audit?targetType=appointment&targetId=${appt.body.id}`)
      .set('Authorization', bearer(f.tenant))
      .expect(200);
    expect(audit.body.data.length).toBeGreaterThan(0);
    const row = audit.body.data[0];
    expect(row.action).toBe('appointment.created');
    expect(row.outcome).toBe('success');
    expect(row.authMethod).toBe('jwt');
    expect(row.snapshotAfter.id).toBe(appt.body.id);
  });

  it('appointment.cancelled writes a row linked to the same target', async () => {
    const f = await fixture(api);
    const appt = await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345031' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(6, 10),
        channel: 'VOICE',
      })
      .expect(201);
    await api.client
      .post(`/appointments/${appt.body.id}/cancel`)
      .set('Authorization', bearer(f.tenant))
      .send({ reason: 'test' })
      .expect(201);
    await new Promise((r) => setTimeout(r, 50));

    const audit = await api.client
      .get(
        `/audit?targetType=appointment&targetId=${appt.body.id}&action=appointment.cancelled`,
      )
      .set('Authorization', bearer(f.tenant))
      .expect(200);
    expect(audit.body.data).toHaveLength(1);
    expect(audit.body.data[0].action).toBe('appointment.cancelled');
  });

  it('api_key.created + api_key.revoked both captured with actorId = OWNER user', async () => {
    const t = await registerTenant(api.client);
    const minted = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(t))
      .send({ name: 'tmp', mode: 'live' })
      .expect(201);
    await api.client
      .delete(`/api-keys/${minted.body.id}`)
      .set('Authorization', bearer(t))
      .expect(200);
    await new Promise((r) => setTimeout(r, 50));

    const audit = await api.client
      .get(`/audit?targetType=api_key&targetId=${minted.body.id}`)
      .set('Authorization', bearer(t))
      .expect(200);
    const actions = audit.body.data.map((r: { action: string }) => r.action);
    expect(actions).toContain('api_key.created');
    expect(actions).toContain('api_key.revoked');
    audit.body.data.forEach((r: { actorId: string | null; actorType: string }) => {
      expect(r.actorType).toBe('user');
      expect(r.actorId).toBe(t.userId);
    });
  });

  it('UPDATE / DELETE on AuditEvent are blocked by the trigger', async () => {
    const f = await fixture(api);
    await api.client
      .post('/appointments')
      .set('Authorization', bearer(f.tenant))
      .send({
        customer: { phone: '+525512345032' },
        staffId: f.staffId,
        serviceId: f.serviceId,
        startTime: futureISO(7, 10),
        channel: 'VOICE',
      })
      .expect(201);
    await new Promise((r) => setTimeout(r, 50));

    // Bypassing REST: connect with the same role the app uses and try to
    // mutate. We assert that the DB itself rejects — no app-level check.
    const { Client } = await import('pg');
    const client = new Client({
      connectionString: 'postgresql://agent_saas_app:app_password_change_me@localhost:5432/agent_saas_test',
    });
    await client.connect();
    try {
      // Set the session vars so RLS lets us SEE the row first.
      await client.query(
        `SELECT set_config('app.current_business_id', $1, false)`,
        [f.tenant.businessId],
      );
      await client.query(`SELECT set_config('app.current_is_test', 'false', false)`);
      const res = await client.query('SELECT id FROM "AuditEvent" LIMIT 1');
      const rowId = res.rows[0]?.id;
      expect(rowId).toBeDefined();
      await expect(
        client.query('UPDATE "AuditEvent" SET outcome = $1 WHERE id = $2', [
          'failure',
          rowId,
        ]),
      ).rejects.toThrow(/append-only|permission|denied/i);
      await expect(
        client.query('DELETE FROM "AuditEvent" WHERE id = $1', [rowId]),
      ).rejects.toThrow(/append-only|permission|denied/i);
    } finally {
      await client.end();
    }
  });

  it('agent (role=AGENT) cannot read the audit log — dashboard only', async () => {
    const t = await registerTenant(api.client);
    const minted = await api.client
      .post('/api-keys')
      .set('Authorization', bearer(t))
      .send({ name: 'voice-agent', mode: 'live' })
      .expect(201);
    await api.client
      .get('/audit')
      .set('x-api-key', minted.body.key)
      .expect(403);
  });
});
