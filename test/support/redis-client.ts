import Redis from 'ioredis';

/**
 * Lightweight Redis helper for test setup/teardown.
 *
 * Deliberately does NOT flush the BullMQ queues DB between tests:
 * BullMQ workers hold long-running BRPOPLPUSH / XREADGROUP connections
 * and don't recover cleanly when the keyspace is wiped under them
 * (the consumer groups are destroyed and subsequent job adds never get
 * processed). Jobs are keyed by ULID (unique per outbox row) so tests
 * cannot collide even with stray residual keys.
 *
 * The Socket.io streams-adapter DB IS safe to flush — the adapter
 * lazily recreates its stream on the next emit.
 */
export class IORedisClient {
  static async flushTestDb(): Promise<void> {
    const host = process.env['REDIS_HOST'] ?? 'localhost';
    const port = Number(process.env['REDIS_PORT'] ?? 6379);
    const realtimeDb = Number(process.env['REDIS_DB_REALTIME'] ?? 14);
    await IORedisClient.flushOne(host, port, realtimeDb);
  }

  private static async flushOne(
    host: string,
    port: number,
    db: number,
  ): Promise<void> {
    const redis = new Redis({ host, port, db, maxRetriesPerRequest: 1 });
    try {
      await redis.flushdb();
    } finally {
      await redis.quit();
    }
  }
}
