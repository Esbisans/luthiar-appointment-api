import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import * as Sentry from '@sentry/nestjs';
import { Job } from 'bullmq';
import { QueueName } from '../queue-names.js';
import { BaseProcessor } from '../base.processor.js';
import { EventPublisherService } from '../../realtime/services/event-publisher.service.js';

/**
 * Dashboard push consumer. Maps every `appointment.*` / `payment.*`
 * event from the outbox to a Socket.io emit into `tenant:<businessId>`.
 *
 * Event name translation: `appointment.created` → `appointment:created`
 * (client-side convention uses colon separators in Socket.io event
 * names; the outbox type uses dots).
 */
@Processor(QueueName.Dashboard, { concurrency: 20 })
export class DashboardProcessor extends BaseProcessor {
  constructor(
    cls: ClsService,
    @InjectPinoLogger(DashboardProcessor.name) logger: PinoLogger,
    private readonly publisher: EventPublisherService,
  ) {
    super(cls, logger);
  }

  async handle(name: string, payload: Record<string, unknown>, _job: Job) {
    const businessId = (payload['businessId'] as string | undefined) ?? '';
    if (!businessId) {
      throw new Error('dashboard job missing businessId in payload');
    }

    // outbox type `appointment.created` → client-facing `appointment:created`.
    const clientEvent = name.replace(/\./g, ':');

    this.publisher.publishToTenant(businessId, clientEvent, payload);
    this.logger.debug(
      { businessId, clientEvent, keys: Object.keys(payload) },
      'dashboard.emitted',
    );
    return { status: 'emitted', event: clientEvent };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    Sentry.captureException(err, {
      tags: { queue: QueueName.Dashboard, jobId: String(job.id), jobName: job.name },
    });
  }
}
