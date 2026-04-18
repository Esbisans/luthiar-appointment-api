import { TestApi } from './support/test-app';
import { bearer, registerTenant } from './support/auth.helper';

async function agentKey(api: TestApi) {
  const owner = await registerTenant(api.client);
  const minted = await api.client
    .post('/api-keys')
    .set('Authorization', bearer(owner))
    .send({ name: 'voice-agent' })
    .expect(201);
  return { owner, apiKey: minted.body.key as string };
}

describe('Conversations (e2e)', () => {
  const api = new TestApi();

  beforeAll(async () => {
    await api.ready();
  });

  beforeEach(async () => {
    await api.resetDb();
    await api.resetRedis();
  });

  it('agent starts a conversation, appends turns, and closes with usage', async () => {
    const { owner, apiKey } = await agentKey(api);
    const roomName = `lk-room-${Date.now()}`;

    const started = await api.client
      .post('/conversations')
      .set('x-api-key', apiKey)
      .send({ channel: 'VOICE', livekitRoomName: roomName })
      .expect(201);
    const id = started.body.id;

    // user turn
    await api.client
      .post(`/conversations/${id}/messages`)
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', `msg-user-0-${Date.now()}`)
      .send({
        turnIndex: 0,
        clientTimestamp: new Date().toISOString(),
        role: 'USER',
        content: 'Hola, quiero agendar una cita',
      })
      .expect(201);

    // assistant turn
    await api.client
      .post(`/conversations/${id}/messages`)
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', `msg-asst-1-${Date.now()}`)
      .send({
        turnIndex: 1,
        clientTimestamp: new Date().toISOString(),
        role: 'ASSISTANT',
        content: 'Claro, con gusto. ¿Qué servicio le interesa?',
        inputTokens: 42,
        outputTokens: 18,
        providerName: 'openai',
        requestModel: 'gpt-4o-mini',
        responseModel: 'gpt-4o-mini-2024-07-18',
        ttftMs: 320,
        latencyMs: 820,
      })
      .expect(201);

    const closed = await api.client
      .post(`/conversations/${id}/close`)
      .set('x-api-key', apiKey)
      .send({
        endedReason: 'COMPLETED',
        summary: 'Cliente interesado en consulta general',
        usage: {
          inputTokens: 42,
          outputTokens: 18,
          sttAudioSeconds: 4.2,
          ttsCharacters: 56,
          totalCostUsd: 0.0012,
        },
      })
      .expect(200);
    expect(closed.body.endedReason).toBe('COMPLETED');
    expect(closed.body.totalInputTokens).toBe(42);

    // Owner reads the conversation from the dashboard (JWT).
    const full = await api.client
      .get(`/conversations/${id}`)
      .set('Authorization', bearer(owner))
      .expect(200);
    expect(full.body.messages).toHaveLength(2);
    expect(full.body.messages[0].turnIndex).toBe(0);
    expect(full.body.messages[1].role).toBe('ASSISTANT');
  });

  it('duplicate start with same livekitRoomName returns the existing conversation', async () => {
    const { apiKey } = await agentKey(api);
    const room = `lk-room-dup-${Date.now()}`;
    const first = await api.client
      .post('/conversations')
      .set('x-api-key', apiKey)
      .send({ channel: 'VOICE', livekitRoomName: room })
      .expect(201);
    const second = await api.client
      .post('/conversations')
      .set('x-api-key', apiKey)
      .send({ channel: 'VOICE', livekitRoomName: room })
      .expect(201);
    expect(second.body.id).toBe(first.body.id);
  });

  it('re-POSTing the same turnIndex is idempotent — returns the first message', async () => {
    const { apiKey } = await agentKey(api);
    const c = await api.client
      .post('/conversations')
      .set('x-api-key', apiKey)
      .send({ channel: 'VOICE' })
      .expect(201);

    const body = {
      turnIndex: 0,
      clientTimestamp: new Date().toISOString(),
      role: 'USER',
      content: 'dup test',
    };
    const first = await api.client
      .post(`/conversations/${c.body.id}/messages`)
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', `dup-${Date.now()}`)
      .send(body)
      .expect(201);
    const second = await api.client
      .post(`/conversations/${c.body.id}/messages`)
      .set('x-api-key', apiKey)
      // Different idempotency key → interceptor inserts; unique
      // (conversationId, turnIndex) catches it → duplicate branch.
      .set('Idempotency-Key', `dup2-${Date.now()}`)
      .send(body)
      .expect(201);
    expect(second.body.message.id).toBe(first.body.message.id);
    expect(second.body.duplicate).toBe(true);
  });

  it('message after close is accepted with 202 + lateArrival flag', async () => {
    const { apiKey } = await agentKey(api);
    const c = await api.client
      .post('/conversations')
      .set('x-api-key', apiKey)
      .send({ channel: 'VOICE' })
      .expect(201);
    await api.client
      .post(`/conversations/${c.body.id}/close`)
      .set('x-api-key', apiKey)
      .send({ endedReason: 'USER_HANGUP' })
      .expect(200);
    const late = await api.client
      .post(`/conversations/${c.body.id}/messages`)
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', `late-${Date.now()}`)
      .send({
        turnIndex: 10,
        clientTimestamp: new Date().toISOString(),
        role: 'USER',
        content: 'straggling STT finalisation',
      })
      .expect(202);
    expect(late.body.lateArrival).toBe(true);
    expect(late.body.message.metadata.lateArrival).toBe(true);
  });

  it('close is idempotent — second close returns the first payload unchanged', async () => {
    const { apiKey } = await agentKey(api);
    const c = await api.client
      .post('/conversations')
      .set('x-api-key', apiKey)
      .send({ channel: 'VOICE' })
      .expect(201);
    const first = await api.client
      .post(`/conversations/${c.body.id}/close`)
      .set('x-api-key', apiKey)
      .send({ endedReason: 'COMPLETED' })
      .expect(200);
    const second = await api.client
      .post(`/conversations/${c.body.id}/close`)
      .set('x-api-key', apiKey)
      // Different reason, but conversation is already closed → ignored.
      .send({ endedReason: 'ERROR' })
      .expect(200);
    expect(second.body.endedAt).toBe(first.body.endedAt);
    expect(second.body.endedReason).toBe('COMPLETED');
  });

  it('out-of-order turns are accepted — messages sort by turnIndex on read', async () => {
    const { owner, apiKey } = await agentKey(api);
    const c = await api.client
      .post('/conversations')
      .set('x-api-key', apiKey)
      .send({ channel: 'VOICE' })
      .expect(201);
    // Post turn 1 BEFORE turn 0.
    await api.client
      .post(`/conversations/${c.body.id}/messages`)
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', `oo-1-${Date.now()}`)
      .send({
        turnIndex: 1,
        clientTimestamp: new Date().toISOString(),
        role: 'ASSISTANT',
        content: 'second',
      })
      .expect(201);
    await api.client
      .post(`/conversations/${c.body.id}/messages`)
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', `oo-0-${Date.now()}`)
      .send({
        turnIndex: 0,
        clientTimestamp: new Date().toISOString(),
        role: 'USER',
        content: 'first',
      })
      .expect(201);

    const full = await api.client
      .get(`/conversations/${c.body.id}`)
      .set('Authorization', bearer(owner))
      .expect(200);
    expect(full.body.messages.map((m: { content: string }) => m.content)).toEqual(
      ['first', 'second'],
    );
  });

  it('cursor pagination returns has_more and starts after the cursor', async () => {
    const { owner, apiKey } = await agentKey(api);
    // Create 5 conversations.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await api.client
        .post('/conversations')
        .set('x-api-key', apiKey)
        .send({ channel: 'VOICE' })
        .expect(201);
      ids.push(r.body.id);
      // Small pause to differentiate startedAt ordering.
      await new Promise((r) => setTimeout(r, 3));
    }
    const page1 = await api.client
      .get('/conversations?limit=2')
      .set('Authorization', bearer(owner))
      .expect(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.has_more).toBe(true);
    const lastId = page1.body.data[1].id;
    const page2 = await api.client
      .get(`/conversations?limit=2&startingAfter=${lastId}`)
      .set('Authorization', bearer(owner))
      .expect(200);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.data[0].id).not.toBe(lastId);
  });

  it('tenant isolation: B cannot see A conversations', async () => {
    const a = await agentKey(api);
    const b = await registerTenant(api.client);
    await api.client
      .post('/conversations')
      .set('x-api-key', a.apiKey)
      .send({ channel: 'VOICE' })
      .expect(201);
    const list = await api.client
      .get('/conversations')
      .set('Authorization', bearer(b))
      .expect(200);
    expect(list.body.data).toHaveLength(0);
  });
});
