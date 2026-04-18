import { Client } from 'pg';
import { IORedisClient } from './redis-client';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';

/**
 * Runs E2E tests against a REAL API booted as a subprocess (see
 * scripts/run-e2e.sh). This avoids the module-resolution fight between
 * jest + ts-jest + nodenext + Prisma's generated client (`import.meta.url`).
 */
export class TestApi {
  readonly baseUrl: string;
  readonly client: TestAgent;

  constructor(baseUrl?: string) {
    this.baseUrl =
      baseUrl ?? process.env['E2E_API_URL'] ?? 'http://localhost:3999';
    this.client = request(this.baseUrl);
  }

  async ready(timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this.client.get('/health/live');
        if (res.status === 200) return;
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`API at ${this.baseUrl} did not become ready in ${timeoutMs}ms`);
  }

  async resetDb(): Promise<void> {
    const url = process.env['MIGRATION_DATABASE_URL'];
    if (!url) {
      throw new Error('MIGRATION_DATABASE_URL not set — run via scripts/run-e2e.sh');
    }
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`
        TRUNCATE
          "OutboxEvent",
          "IdempotencyKey",
          "Notification",
          "Message",
          "Conversation",
          "Payment",
          "Appointment",
          "BlockedTime",
          "StaffAvailability",
          "StaffService",
          "BusinessHour",
          "Holiday",
          "Customer",
          "Service",
          "Staff",
          "ApiKey",
          "NotificationSetting",
          "RefreshToken",
          "User",
          "Business"
        RESTART IDENTITY CASCADE
      `);
    } finally {
      await client.end();
    }
  }

  async resetRedis(): Promise<void> {
    await IORedisClient.flushTestDb();
  }
}
