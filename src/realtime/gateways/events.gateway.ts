import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import { Server, Socket } from 'socket.io';
import { EventPublisherService } from '../services/event-publisher.service.js';
import { ReplayService } from '../services/replay.service.js';
import { registerWsAuth } from '../middleware/ws-auth.middleware.js';
import { parseSyncRequest } from '../dto/sync-request.dto.js';

/**
 * Main WebSocket gateway.
 *
 * Namespace `/events` keeps room semantics isolated from future
 * gateways (e.g. `/presence`, `/admin`). Transports restricted to
 * `websocket` only — no long-polling fallback — so we never need
 * sticky sessions in Kubernetes.
 *
 * Auth: JWT via `socket.handshake.auth.token`, validated in
 * `registerWsAuth()` middleware that runs once per connection.
 *
 * Connection State Recovery enabled (2 min window) so brief
 * disconnects do not drop client state. For longer gaps, the client
 * emits `events:sync` and we replay from the outbox.
 */
@WebSocketGateway({
  namespace: '/events',
  cors: {
    origin: process.env['CORS_ORIGINS']?.split(',') ?? '*',
    credentials: true,
  },
  transports: ['websocket'],
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly publisher: EventPublisherService,
    private readonly replay: ReplayService,
    @InjectPinoLogger(EventsGateway.name)
    private readonly logger: PinoLogger,
  ) {}

  afterInit(server: Server): void {
    registerWsAuth(server, this.jwt);
    this.publisher.bind(server);
    this.logger.info('realtime gateway ready on /events');
  }

  async handleConnection(socket: Socket): Promise<void> {
    const businessId = socket.data['businessId'] as string;
    const userId = socket.data['userId'] as string;
    const role = socket.data['role'] as string;

    // Three rooms per socket — covers tenant fan-out, direct user
    // messages (session revocation, personal notifications), and
    // role-scoped broadcasts (OWNER-only alerts).
    await socket.join([
      `tenant:${businessId}`,
      `user:${userId}`,
      `role:${businessId}:${role}`,
    ]);

    this.logger.info(
      { socketId: socket.id, businessId, userId, role, recovered: socket.recovered },
      'socket.connected',
    );
  }

  handleDisconnect(socket: Socket): void {
    this.logger.info(
      { socketId: socket.id, businessId: socket.data['businessId'] },
      'socket.disconnected',
    );
  }

  /**
   * Client sends `{ since: <lastEventId>, limit? }` after a long
   * disconnect (past the 2-min CSR window). We return every outbox
   * event with an id greater than `since` for the caller's tenant.
   */
  @SubscribeMessage('events:sync')
  async onSync(
    @ConnectedSocket() socket: Socket,
    @MessageBody() raw: unknown,
  ): Promise<{ events: unknown[]; truncated: boolean }> {
    const req = parseSyncRequest(raw);
    if (!req) {
      return { events: [], truncated: false };
    }
    const businessId = socket.data['businessId'] as string;
    const rows = await this.replay.fetchSince(
      businessId,
      req.since,
      req.limit ?? 100,
    );
    return {
      events: rows.map((r) => ({
        id: r.id,
        type: r.type,
        payload: r.payload,
        createdAt: r.createdAt.toISOString(),
      })),
      truncated: rows.length === (req.limit ?? 100),
    };
  }
}
