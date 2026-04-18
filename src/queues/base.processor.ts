import { WorkerHost } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { Job } from 'bullmq';

/**
 * Context serialized into every job's `data._ctx` so the worker can
 * rehydrate CLS (businessId, traceId, userId). Without this, the Prisma
 * interceptor cannot set the RLS session variable and queries would leak
 * cross-tenant OR fail silently.
 */
export interface JobContext {
  businessId?: string;
  userId?: string;
  traceId?: string;
  jobId?: string;
}

export const CTX_KEY = '_ctx';

/**
 * Base class every processor extends. Override `handle(name, payload, job)`
 * to receive the de-shelled payload without `_ctx` and with CLS already
 * populated.
 */
export abstract class BaseProcessor extends WorkerHost {
  constructor(
    protected readonly cls: ClsService,
    protected readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const raw = (job.data ?? {}) as Record<string, unknown>;
    const ctx = (raw[CTX_KEY] as JobContext | undefined) ?? {};
    const { [CTX_KEY]: _discard, ...payload } = raw;

    return this.cls.runWith(
      {},
      async () => {
        // Populate keys that Prisma interceptor + pino customProps read from CLS.
        if (ctx.businessId) this.cls.set('businessId', ctx.businessId);
        if (ctx.userId) this.cls.set('userId', ctx.userId);
        if (ctx.traceId) this.cls.set('traceId', ctx.traceId);
        this.cls.set('jobId', job.id);
        this.cls.set('jobName', job.name);

        this.logger.info(
          {
            queue: job.queueName,
            jobId: job.id,
            jobName: job.name,
            attempt: job.attemptsMade + 1,
            traceId: ctx.traceId,
            businessId: ctx.businessId,
          },
          'job.start',
        );

        try {
          const result = await this.handle(job.name, payload, job);
          this.logger.info(
            { queue: job.queueName, jobId: job.id, jobName: job.name },
            'job.success',
          );
          return result;
        } catch (err) {
          this.logger.error(
            {
              err,
              queue: job.queueName,
              jobId: job.id,
              jobName: job.name,
              attempt: job.attemptsMade + 1,
              traceId: ctx.traceId,
              businessId: ctx.businessId,
            },
            'job.failure',
          );
          throw err;
        }
      },
    );
  }

  abstract handle(
    name: string,
    payload: Record<string, unknown>,
    job: Job,
  ): Promise<unknown>;
}
