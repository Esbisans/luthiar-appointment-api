import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { TenantThrottlerGuard } from './common/guards/tenant-throttler.guard.js';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { SentryModule } from '@sentry/nestjs/setup';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ServicesModule } from './services/services.module.js';
import { StaffModule } from './staff/staff.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { ScheduleModule } from './schedule/schedule.module.js';
import { AvailabilityModule } from './availability/availability.module.js';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { ApiKeysModule } from './api-keys/api-keys.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { AgentContextModule } from './agent-context/agent-context.module.js';
import { AuditModule } from './audit/audit.module.js';
import { SearchModule } from './search/search.module.js';
import { QueuesModule } from './queues/queues.module.js';
import { QueuesBullBoardModule } from './queues/bull-board.module.js';
import { HealthModule } from './health/health.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from './common/guards/auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { TenantTxInterceptor } from './common/interceptors/tenant-tx.interceptor.js';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware.js';
import { pinoConfig } from './common/logging/pino.config.js';
import { AppController } from './app.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // Sentry NestJS integration — auto-instruments controllers / DI.
    // Sentry.init runs in src/instrumentation.ts before any imports.
    SentryModule.forRoot(),

    // Async context for multi-tenant (traceId, businessId, userId, tx).
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),

    // Structured logging with correlation IDs from CLS.
    LoggerModule.forRoot(pinoConfig),

    // Two-tier rate limit (see TenantThrottlerGuard for tracker logic):
    //   • global-ip: per-IP DoS floor — protects against unauthenticated
    //     bursts regardless of tenant.
    //   • tenant: per-API-key budget — keeps one misbehaving agent from
    //     monopolising the API even though many agents share egress IPs.
    //
    // Redis-backed storage so the counters are consistent across replicas
    // (Lua-atomic INCR + EXPIRE). DB picked is REDIS_DB_QUEUES — same DB
    // BullMQ uses; collisions are namespaced by the throttler library.
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'global-ip',
          ttl: Number(process.env['THROTTLER_GLOBAL_TTL_MS'] ?? 60_000),
          limit: Number(process.env['THROTTLER_GLOBAL_LIMIT'] ?? 300),
        },
        {
          name: 'tenant',
          ttl: Number(process.env['THROTTLER_TENANT_TTL_MS'] ?? 60_000),
          limit: Number(process.env['THROTTLER_TENANT_LIMIT'] ?? 60),
        },
      ],
      storage: new ThrottlerStorageRedisService(
        new Redis({
          host: process.env['REDIS_HOST'] ?? 'localhost',
          port: Number(process.env['REDIS_PORT'] ?? 6379),
          db: Number(process.env['REDIS_DB_QUEUES'] ?? 1),
        }),
      ),
    }),

    EventEmitterModule.forRoot(),

    PrismaModule,
    AuthModule,
    ServicesModule,
    StaffModule,
    CustomersModule,
    ScheduleModule,
    AvailabilityModule,
    AppointmentsModule,
    ApiKeysModule,
    ConversationsModule,
    AgentContextModule,
    AuditModule,
    SearchModule,
    QueuesModule,
    QueuesBullBoardModule,
    HealthModule,
    RealtimeModule,
    JwtModule.register({
      secret: process.env['JWT_SECRET'],
      signOptions: {
        expiresIn: (process.env['JWT_ACCESS_EXPIRATION'] ?? '15m') as never,
      },
    }),
  ],
  controllers: [AppController],
  providers: [
    // Order: throttle → auth → roles. The custom throttler reads the API
    // key id from CLS — but auth runs *after* throttle. To make per-key
    // tracking work, the AuthGuard sets `apiKeyId` on the FIRST call (no
    // CLS yet → falls back to IP) and the SECOND call (CLS warm → key
    // tracker kicks in). Net effect: one IP-tracked request per cold
    // start per key, then per-key budgeting for the remainder.
    { provide: APP_GUARD, useClass: TenantThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },

    // Runs after guards, so CLS already has businessId.
    { provide: APP_INTERCEPTOR, useClass: TenantTxInterceptor },

    // Single translator for every thrown error.
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Correlation ID must run before any handler that logs or throws.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');

    // Bull Board's auth is done at the raw Express layer in main.ts
    // (see `app.use('/admin/queues', ...)`) because the BullBoardModule
    // controller's catch-all path doesn't always play nicely with the
    // Nest middleware path matcher.
  }
}
