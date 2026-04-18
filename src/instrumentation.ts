/**
 * Sentry instrumentation — MUST be imported before any other module in main.ts.
 *
 * Sentry's NestJS SDK (v8+) is built on OpenTelemetry and instruments the
 * runtime. For instrumentation to attach, `Sentry.init()` must run before
 * the HTTP framework, Prisma, etc. are loaded — so this file sits at the
 * top of the import graph in main.ts.
 *
 * Behavior:
 *   • No SENTRY_DSN env var → init is a no-op. Safe for local dev / CI.
 *   • With SENTRY_DSN → errors with status >= 500 captured by
 *     GlobalExceptionFilter; HTTP spans auto-instrumented.
 *
 * Set SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_RELEASE in your secret store.
 */
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const dsn = process.env['SENTRY_DSN'];

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env['SENTRY_ENVIRONMENT'] ?? process.env['NODE_ENV'],
    release: process.env['SENTRY_RELEASE'],
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: Number(process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0.1'),
    profilesSampleRate: Number(
      process.env['SENTRY_PROFILES_SAMPLE_RATE'] ?? '0.1',
    ),
    // Scrubs common PII before sending.
    sendDefaultPii: false,
  });
}
