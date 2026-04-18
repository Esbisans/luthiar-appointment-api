// MUST be first — wires Sentry's OpenTelemetry instrumentation before
// anything else loads. No-op if SENTRY_DSN is not set.
import './instrumentation.js';

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger as PinoAppLogger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { createValidationPipe } from './common/pipes/validation-pipe.factory.js';
import { UserRole } from './generated/prisma/enums.js';
import { RedisIoAdapter } from './realtime/adapters/redis-io.adapter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoAppLogger));

  const configService = app.get(ConfigService);

  // Helmet — JSON API, not HTML. CSP belongs on the Next.js frontend, and
  // the default `Cross-Origin-Resource-Policy: same-origin` breaks the
  // dashboard's cross-origin fetch. Keep HSTS / nosniff / frameguard /
  // referrer-policy / hide x-powered-by (all enabled by default).
  // Parse Cookie header into `req.cookies`. Required for the auth flow
  // (HttpOnly cookies set by /auth/login → read by AuthGuard / refresh).
  app.use(cookieParser());

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // CORS — function-based origin callback. 2025 canonical pattern:
  //   • dev (NODE_ENV !== 'production'): any `http://localhost:<port>` or
  //     `http://127.0.0.1:<port>` passes, so the developer can open the
  //     dashboard on 3000, 3001, 3002, … without editing config each time.
  //   • prod: strict allowlist from `DASHBOARD_ORIGINS` (comma-separated).
  //   • No-Origin requests (curl, server-to-server, health probes) always
  //     pass — CORS is a browser-enforced check.
  // `credentials: true` enables HttpOnly cookie auth when we adopt it;
  // `exposedHeaders` lets TanStack Query / fetch read our custom headers.
  const allowedOrigins = (process.env['DASHBOARD_ORIGINS'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const devOriginRegex = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;
  const isProd = process.env['NODE_ENV'] === 'production';

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (!isProd && devOriginRegex.test(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    exposedHeaders: [
      'X-Request-Id',
      'ETag',
      'traceparent',
      'RateLimit',
      'RateLimit-Policy',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
  });

  // Socket.io adapter backed by Redis Streams — enables multi-pod
  // fan-out + Connection State Recovery across restarts.
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  // Bull Board lives at `/admin/queues` as a Nest controller with a
  // catch-all pattern. Nest's `MiddlewareConsumer` path matcher has edge
  // cases with that, so we attach a raw Express middleware here to
  // enforce OWNER-only access BEFORE Nest's router sees the request.
  const jwt = app.get(JwtService);
  app.use(
    '/admin/queues',
    async (req: Request, res: Response, next: NextFunction) => {
      const header = req.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      if (!token) {
        return res.status(401).json({
          error: { code: 'AUTH_REQUIRED', message: 'Missing Bearer token', status: 401 },
        });
      }
      try {
        const payload = await jwt.verifyAsync<{ role?: string }>(token);
        if (payload.role !== UserRole.OWNER) {
          return res.status(401).json({
            error: {
              code: 'FORBIDDEN',
              message: 'OWNER role required for Bull Board',
              status: 401,
            },
          });
        }
        next();
      } catch {
        res.status(401).json({
          error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token', status: 401 },
        });
      }
    },
  );

  // Validation pipe → emits DomainError on failure (handled by filter).
  app.useGlobalPipes(createValidationPipe());

  // ── OpenAPI / Swagger ─────────────────────────────────────────────
  //
  // Three-layer strategy:
  //
  //   1. **Dev / test / staging** (`NODE_ENV !== 'production'`):
  //      both `/api/docs` (UI) and `/api/docs-json` (machine-readable
  //      schema) are open. Let the frontend run `openapi-typescript
  //      http://localhost:3999/api/docs-json -o types.ts` without
  //      friction.
  //
  //   2. **Production** (`NODE_ENV === 'production'`):
  //      same routes are gated behind an `OWNER` JWT — identical
  //      pattern to Bull Board above. Admins can still consult the live
  //      docs; anonymous visitors see 401. Info-disclosure surface
  //      matches OWASP API9:2023 guidance.
  //
  //   3. **Production type generation**: the dashboard's CI points at
  //      a dedicated staging env (or uses an OWNER bearer for the prod
  //      `/api/docs-json` fetch). Runtime-from-dashboard is not
  //      expected; types are baked at build time and committed.
  //
  // Both /api/docs AND /api/docs-json are gated together — gating only
  // the UI while leaving the JSON open is security theater (the JSON
  // has everything the UI has: enum values, endpoints, schemas).
  const swaggerRequiresAuth = process.env['NODE_ENV'] === 'production';

  if (swaggerRequiresAuth) {
    app.use(
      ['/api/docs', '/api/docs-json', '/api/docs-yaml'],
      async (req: Request, res: Response, next: NextFunction) => {
        const header = req.headers.authorization;
        const token = header?.startsWith('Bearer ')
          ? header.slice(7)
          : undefined;
        if (!token) {
          return res.status(401).json({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Missing Bearer token',
              status: 401,
            },
          });
        }
        try {
          const payload = await jwt.verifyAsync<{ role?: string }>(token);
          if (payload.role !== UserRole.OWNER) {
            return res.status(403).json({
              error: {
                code: 'FORBIDDEN',
                message: 'OWNER role required for API docs',
                status: 403,
              },
            });
          }
          next();
        } catch {
          res.status(401).json({
            error: {
              code: 'INVALID_TOKEN',
              message: 'Invalid or expired token',
              status: 401,
            },
          });
        }
      },
    );
  }

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Agent SaaS API')
    .setDescription(
      'Multi-tenant appointment scheduling and AI voice agent platform',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const documentFactory = () =>
    SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, documentFactory, {
    jsonDocumentUrl: 'api/docs-json',
  });

  app.enableShutdownHooks();

  // Node http.Server timeouts — outer envelope for the defense-in-depth
  // timeout stack. Must be set BEFORE `app.listen()`:
  //
  //   • requestTimeout (60s) — total time to receive + respond to a
  //     single request. Larger than Postgres statement_timeout (30s)
  //     so DB layer wins for real work; this catches stuck handlers.
  //     Node default is 300s (too permissive).
  //   • headersTimeout (65s) — time to receive headers. Node enforces
  //     `headersTimeout > keepAliveTimeout`, so this must exceed the
  //     keep-alive below.
  //   • keepAliveTimeout (61s) — idle socket timeout. Intentionally
  //     above common load-balancer defaults (AWS ALB = 60s) to avoid
  //     the LB-closes-first race → 502s. If we ever put this behind a
  //     different LB, bump to stay above its idle value.
  //
  // https://nodejs.org/docs/latest/api/http.html#serverrequesttimeout
  const httpServer = app.getHttpServer() as import('node:http').Server;
  httpServer.requestTimeout = 60_000;
  httpServer.headersTimeout = 65_000;
  httpServer.keepAliveTimeout = 61_000;

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);
}
bootstrap();
