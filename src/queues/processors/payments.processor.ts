import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import * as Sentry from '@sentry/nestjs';
import { Job } from 'bullmq';
import { QueueName } from '../queue-names.js';
import { BaseProcessor } from '../base.processor.js';

@Processor(QueueName.Payments, { concurrency: 5 })
export class PaymentsProcessor extends BaseProcessor {
  constructor(
    cls: ClsService,
    @InjectPinoLogger(PaymentsProcessor.name) logger: PinoLogger,
  ) {
    super(cls, logger);
  }

  async handle(name: string, payload: Record<string, unknown>, _job: Job) {
    switch (name) {
      case 'process-stripe-webhook':
      case 'issue-refund':
        this.logger.info({ jobName: name, payload }, 'payments.stub');
        return { status: 'stubbed', jobName: name };
      default:
        throw new Error(`Unknown payments job: ${name}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    Sentry.captureException(err, {
      tags: { queue: QueueName.Payments, jobId: String(job.id), jobName: job.name },
    });
  }
}
