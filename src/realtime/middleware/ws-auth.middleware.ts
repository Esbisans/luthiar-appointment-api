import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';

/**
 * Socket.io middleware that runs once at handshake. Validates the JWT
 * passed in `socket.handshake.auth.token` and attaches the resolved
 * identity to `socket.data` — which lives server-side only and cannot
 * be mutated by the client.
 *
 * We do NOT revalidate per event (NestJS `@UseGuards` pattern) because
 * that adds RTT overhead for every push. Handshake-only auth is the
 * 2026 consensus; a revoked token can still be disconnected later via
 * an internal event bus that calls `server.in(`user:${userId}`).
 * disconnectSockets()` — deferred to a follow-up issue.
 */
export function registerWsAuth(server: Server, jwt: JwtService): void {
  server.use(async (socket: Socket, next) => {
    try {
      const token = (socket.handshake.auth?.['token'] ?? '') as string;
      if (!token) return next(new Error('AUTH_REQUIRED'));

      const payload = await jwt.verifyAsync<{
        sub: string;
        businessId: string;
        role: string;
      }>(token);

      if (!payload?.businessId || !payload?.sub || !payload?.role) {
        return next(new Error('INVALID_TOKEN'));
      }

      socket.data['userId'] = payload.sub;
      socket.data['businessId'] = payload.businessId;
      socket.data['role'] = payload.role;
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });
}
