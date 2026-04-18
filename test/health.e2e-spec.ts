import { TestApi } from './support/test-app';

describe('Health (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  it('/health/live returns 200 without auth', async () => {
    const res = await api.client.get('/health/live').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('/health/ready returns 200 with database + redis UP', async () => {
    const res = await api.client.get('/health/ready').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
    expect(res.body.info.redis.status).toBe('up');
  });
});
