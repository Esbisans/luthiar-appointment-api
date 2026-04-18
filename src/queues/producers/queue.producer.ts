import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { Queue, JobsOptions } from 'bullmq';
import { ulid } from 'ulid';
import { QueueName, QueueNameValue } from '../queue-names.js';
import { CTX_KEY, JobContext } from '../base.processor.js';

const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400 },
};

/**
 * Thin wrapper over BullMQ `Queue.add()` that:
 *   1. Serializes the current CLS (businessId, traceId, userId) into
 *      `job.data._ctx` so the worker can rehydrate.
 *   2. Applies the project's default retry/backoff policy.
 *   3. Generates a ULID traceId if none exists (rare — outbox fires
 *      outside a request context).
 */
@Injectable()
export class QueueProducer {
  constructor(
    private readonly cls: ClsService,
    @InjectQueue(QueueName.Notifications) private readonly notifications: Queue,
    @InjectQueue(QueueName.Payments) private readonly payments: Queue,
    @InjectQueue(QueueName.Dashboard) private readonly dashboard: Queue,
    @InjectQueue(QueueName.Outbox) private readonly outbox: Queue,
  ) {}

  async enqueue<T extends Record<string, unknown>>(
    queue: QueueNameValue,
    name: string,
    payload: T,
    opts: JobsOptions = {},
  ) {
    const ctx: JobContext = {
      businessId: this.safeCls('businessId'),
      userId: this.safeCls('userId'),
      traceId: this.safeCls('traceId') ?? ulid(),
    };
    const data = { ...payload, [CTX_KEY]: ctx };
    return this.getQueue(queue).add(name, data, { ...DEFAULT_JOB_OPTS, ...opts });
  }

  async remove(queue: QueueNameValue, jobId: string): Promise<boolean> {
    const job = await this.getQueue(queue).getJob(jobId);
    if (!job) return false;
    await job.remove();
    return true;
  }

  getQueue(queue: QueueNameValue): Queue {
    switch (queue) {
      case QueueName.Notifications:
        return this.notifications;
      case QueueName.Payments:
        return this.payments;
      case QueueName.Dashboard:
        return this.dashboard;
      case QueueName.Outbox:
        return this.outbox;
    }
  }

  private safeCls(key: string): string | undefined {
    try {
      return this.cls.get<string>(key);
    } catch {
      return undefined;
    }
  }
}
