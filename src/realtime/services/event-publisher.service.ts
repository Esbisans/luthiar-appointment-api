import { Injectable } from '@nestjs/common';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import type { Server } from 'socket.io';

/**
 * Thin facade around `io.to(room).emit(...)`. Injected into the
 * DashboardProcessor (and future real-time producers) so no caller
 * touches the Socket.io Server directly.
 *
 * The Server reference is set by `EventsGateway.afterInit()` — before
 * that, publish() is a no-op (logged at warn) so an early boot event
 * doesn't crash.
 */
@Injectable()
export class EventPublisherService {
  private server?: Server;

  constructor(
    @InjectPinoLogger(EventPublisherService.name)
    private readonly logger: PinoLogger,
  ) {}

  bind(server: Server): void {
    this.server = server;
  }

  /**
   * Emit an event to all sockets in the given tenant's room.
   * No-op with warning if the server isn't ready yet.
   */
  publishToTenant(
    businessId: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.server) {
      this.logger.warn(
        { event, businessId },
        'event-publisher not bound — dropping message',
      );
      return;
    }
    this.server.to(`tenant:${businessId}`).emit(event, payload);
  }

  /** Emit to a single user (e.g. session revocation signal). */
  publishToUser(
    userId: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.server) return;
    this.server.to(`user:${userId}`).emit(event, payload);
  }
}
