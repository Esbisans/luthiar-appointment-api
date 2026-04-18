import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import Redis from 'ioredis';

/**
 * Multi-pod Socket.io adapter backed by Redis Streams.
 *
 * Why Streams and not the classic `@socket.io/redis-adapter`:
 *   • Classic pub/sub adapter does NOT support Connection State
 *     Recovery — the feature we need so short disconnects (2 min) don't
 *     drop client state.
 *   • Streams adapter writes events to a Redis Stream; consumers (other
 *     pods) read from it. Survives Redis restarts as long as the stream
 *     isn't trimmed aggressively.
 *
 * Uses a separate Redis logical DB (`REDIS_DB_REALTIME`, defaults to 2)
 * so the `socket.io:*` keyspace never collides with BullMQ's `bull:*`.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const host = process.env['REDIS_HOST'] ?? 'localhost';
    const port = Number(process.env['REDIS_PORT'] ?? 6379);
    const db = Number(process.env['REDIS_DB_REALTIME'] ?? 2);

    const client = new Redis({
      host,
      port,
      db,
      // Required for the Streams adapter's XREAD blocking calls.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.adapterConstructor = createAdapter(client, {
      // Keep the last 10k events in the stream — more than enough for
      // short-window recovery while bounding Redis memory.
      streamName: 'socket.io:events',
      maxLen: 10_000,
    });
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as {
      adapter: (factory: unknown) => void;
    };
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
