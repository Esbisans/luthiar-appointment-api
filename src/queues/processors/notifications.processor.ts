import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import * as Sentry from '@sentry/nestjs';
import { Job } from 'bullmq';
import { QueueName } from '../queue-names.js';
import { BaseProcessor } from '../base.processor.js';

/**
 * STUB processor. Each job name logs the payload and completes.
 * Real WhatsApp / SMS / email integration lands with:
 *   • Fase 3 (Stripe + Twilio) for SMS payment links
 *   • Fase 5 (Meta WhatsApp API) for appointment reminders
 * See docs/deferred-work.md D45.
 */
@Processor(QueueName.Notifications, {
  concurrency: 10,
  limiter: { max: 30, duration: 1_000 },
})
export class NotificationsProcessor extends BaseProcessor {
  constructor(
    cls: ClsService,
    @InjectPinoLogger(NotificationsProcessor.name) logger: PinoLogger,
  ) {
    super(cls, logger);
  }

  async handle(name: string, payload: Record<string, unknown>, _job: Job) {
    // Accept both direct reminder job names AND the appointment.* lifecycle
    // events published by the outbox. Real side-effects are stubbed — they
    // land with Fase 3 (Stripe+Twilio SMS) and Fase 5 (Meta WhatsApp).
    const KNOWN = new Set<string>([
      // Scheduled
      'send-confirmation',
      'send-reminder-24h',
      'send-reminder-1h',
      'send-followup',
      'retry-failed',
      // Outbox → notifications fan-out
      'appointment.created',
      'appointment.confirmed',
      'appointment.cancelled',
      'appointment.rescheduled',
      'appointment.checked_in',
      'appointment.completed',
      'appointment.no_show',
    ]);
    if (!KNOWN.has(name)) {
      throw new Error(`Unknown notifications job: ${name}`);
    }
    this.logger.info({ jobName: name, payload }, 'notifications.stub');
    return { status: 'stubbed', jobName: name };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    Sentry.captureException(err, {
      tags: {
        queue: QueueName.Notifications,
        jobId: String(job.id),
        jobName: job.name,
      },
    });
  }
}
