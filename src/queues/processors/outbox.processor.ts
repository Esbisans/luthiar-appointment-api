import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import * as Sentry from '@sentry/nestjs';
import { Job } from 'bullmq';
import { ModuleRef } from '@nestjs/core';
import { QueueName } from '../queue-names.js';
import { BaseProcessor } from '../base.processor.js';

/**
 * Safety-net cron: re-dispatches OutboxEvent rows stuck in PENDING
 * (should only happen if the process crashed between tx commit and
 * flushPending()). Uses ModuleRef to resolve OutboxService lazily and
 * break the circular import with AppointmentsModule.
 */
@Processor(QueueName.Outbox, { concurrency: 1 })
export class OutboxProcessor extends BaseProcessor {
  constructor(
    cls: ClsService,
    @InjectPinoLogger(OutboxProcessor.name) logger: PinoLogger,
    private readonly moduleRef: ModuleRef,
  ) {
    super(cls, logger);
  }

  async handle(name: string, _payload: Record<string, unknown>, _job: Job) {
    if (name !== 'outbox-flush') {
      throw new Error(`Unknown outbox job: ${name}`);
    }
    // Resolve lazily to avoid circular module dep at bootstrap.
    const { OutboxService } = await import('../../appointments/events/outbox.service.js');
    const outbox = this.moduleRef.get(OutboxService, { strict: false });
    await outbox.flushPending();
    return { status: 'ok' };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    Sentry.captureException(err, {
      tags: { queue: QueueName.Outbox, jobId: String(job.id), jobName: job.name },
    });
  }
}
