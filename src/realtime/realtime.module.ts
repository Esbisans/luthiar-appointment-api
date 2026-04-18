import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EventsGateway } from './gateways/events.gateway.js';
import { EventPublisherService } from './services/event-publisher.service.js';
import { ReplayService } from './services/replay.service.js';

/**
 * Real-time module. Exports `EventPublisherService` so queue processors
 * (Dashboard) can push events to connected clients.
 *
 * `@Global` because the publisher is consumed from a BullMQ processor
 * (QueuesModule) and we don't want a circular import dance.
 */
@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'],
      signOptions: {
        expiresIn: (process.env['JWT_ACCESS_EXPIRATION'] ?? '15m') as never,
      },
    }),
  ],
  providers: [EventsGateway, EventPublisherService, ReplayService],
  exports: [EventPublisherService],
})
export class RealtimeModule {}
