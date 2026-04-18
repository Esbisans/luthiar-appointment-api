import { io, Socket } from 'socket.io-client';

export interface WsClientOptions {
  token: string;
  baseUrl?: string;
}

/**
 * Thin wrapper around socket.io-client for E2E tests.
 * Connects to `/events` namespace with JWT in handshake.auth.
 * Exposes `waitForEvent(name, timeoutMs)` as a Promise so tests don't
 * race on fire-and-forget emits.
 */
export class WsClient {
  socket!: Socket;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(opts: WsClientOptions) {
    this.baseUrl =
      opts.baseUrl ?? process.env['E2E_API_URL'] ?? 'http://localhost:3999';
    this.token = opts.token;
  }

  async connect(): Promise<void> {
    this.socket = io(`${this.baseUrl}/events`, {
      auth: { token: this.token },
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('ws connect timeout')),
        5_000,
      );
      this.socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    // The server-side `handleConnection` hook performs `socket.join(...)`
    // AFTER the client's `connect` event fires. Give it a tick so tests
    // that immediately emit from the REST side don't race the join.
    await new Promise((r) => setTimeout(r, 50));
  }

  async waitForEvent<T = unknown>(name: string, timeoutMs = 2_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off(name);
        reject(new Error(`did not receive ${name} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.socket.once(name, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  async emit<Req, Res>(event: string, payload: Req): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`emit ${event} timed out`)),
        5_000,
      );
      this.socket.emit(event, payload, (response: Res) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  close(): void {
    if (this.socket?.connected) this.socket.disconnect();
  }
}
