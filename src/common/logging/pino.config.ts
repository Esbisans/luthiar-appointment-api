import { Params } from 'nestjs-pino';
import { ClsServiceManager } from 'nestjs-cls';
import {
  CLS_SESSION_ID_KEY,
  CLS_TRACE_ID_KEY,
  CLS_TRACEPARENT_KEY,
  CLS_VOICE_CALL_ID_KEY,
} from '../middleware/correlation-id.middleware.js';

/**
 * Pino config. One opinion, applied everywhere.
 *
 *   • Dev: pino-pretty, human-readable single lines.
 *   • Prod: structured JSON to stdout (picked up by Vector / Fluent Bit /
 *     Loki / Datadog / whatever).
 *   • Redacts secrets (Authorization, Cookie, passwords, tokens, API keys)
 *     before anything leaves the process.
 *   • Every log line auto-includes `traceId`, `tenantId`, `userId` from CLS
 *     so a single grep pivots from an error back to the originating
 *     request.
 *   • HTTP log level is derived from the response: 5xx = error, 4xx = warn,
 *     2xx/3xx = info. The filter also logs via pino so level is consistent.
 */
export const pinoConfig: Params = {
  pinoHttp: {
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport:
      process.env['NODE_ENV'] !== 'production'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,req,res,responseTime',
              messageFormat: '{msg} {req.method} {req.url} → {res.statusCode} ({responseTime}ms) [{traceId}]',
            },
          }
        : undefined,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        '*.password',
        '*.token',
        '*.refreshToken',
        '*.accessToken',
        '*.apiKey',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
    customProps: () => {
      try {
        const cls = ClsServiceManager.getClsService();
        // Optional fields are only emitted when set (undefined → not in
        // the JSON line) so log lines stay compact in dev when no agent
        // headers are present.
        return omitUndefined({
          traceId: cls.get<string>(CLS_TRACE_ID_KEY),
          tenantId: cls.get<string>('businessId'),
          userId: cls.get<string>('userId'),
          authMethod: cls.get<string>('authMethod'),
          apiKeyId: cls.get<string>('apiKeyId'),
          voiceCallId: cls.get<string>(CLS_VOICE_CALL_ID_KEY),
          sessionId: cls.get<string>(CLS_SESSION_ID_KEY),
          traceparent: cls.get<string>(CLS_TRACEPARENT_KEY),
        });
      } catch {
        return {};
      }
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    genReqId: (req) => (req as { id?: string }).id ?? 'pending',
    // Correlation ID is also added to response headers elsewhere
    // (CorrelationIdMiddleware). Pino only logs it.
    autoLogging: {
      ignore: (req) => {
        const url = (req as { url?: string }).url;
        return url === '/health' || !!url?.startsWith('/health?');
      },
    },
  },
};

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
