import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ClsService } from 'nestjs-cls';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InvalidTokenError } from '../errors/index.js';
import {
  extractPrefix,
  hashKey,
  isValidKeyFormat,
} from '../../api-keys/utils/api-key-format.js';

const LAST_USED_THROTTLE_MS = 60_000;

declare module 'express' {
  interface Request {
    user?: {
      userId?: string;
      businessId: string;
      role: string;
      authType: 'jwt' | 'apikey';
    };
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
    private cls: ClsService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      return this.validateApiKey(request, apiKey);
    }

    // JWT may arrive via Authorization header (mobile, agents,
    // server-to-server) OR via the `access_token` HttpOnly cookie set
    // by `/auth/login` for browsers. Same JwtService verification path.
    const token =
      this.extractTokenFromHeader(request) ??
      this.extractTokenFromCookie(request);
    if (token) {
      return this.validateJwt(request, token);
    }

    throw new InvalidTokenError('Authentication required');
  }

  private async validateJwt(
    request: Request,
    token: string,
  ): Promise<boolean> {
    try {
      const payload = await this.jwtService.verifyAsync(token);
      request.user = {
        userId: payload.sub,
        businessId: payload.businessId,
        role: payload.role,
        authType: 'jwt',
      };
      this.cls.set('userId', payload.sub);
      this.cls.set('businessId', payload.businessId);
      this.cls.set('role', payload.role);
      this.cls.set('authMethod', 'jwt');
      // `sid` (session id = familyId) is set on tokens issued AFTER the
      // refresh-family migration. Older JWTs in flight don't carry it
      // — that's harmless; sessions endpoints / blocklist features
      // simply won't apply until those tokens expire.
      if (typeof payload.sid === 'string') {
        this.cls.set('sessionId', payload.sid);
      }
      return true;
    } catch {
      throw new InvalidTokenError('Invalid or expired token');
    }
  }

  private async validateApiKey(
    request: Request,
    key: string,
  ): Promise<boolean> {
    // Cheap offline check: format + CRC32 — rejects bots probing random
    // strings without a DB round-trip.
    if (!isValidKeyFormat(key)) {
      throw new InvalidTokenError('Invalid API key');
    }

    const keyHash = hashKey(key);
    const prefix = extractPrefix(key);

    // Prefix-narrowed lookup uses the (businessId, revokedAt) index path
    // poorly, but the prefix itself is reasonably selective (<10 keys per
    // tenant typically). The keyHash unique index would also work; we
    // keep prefix in the WHERE for forward-compat with sharded reads.
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { keyHash, prefix, isActive: true, revokedAt: null },
    });

    if (!apiKey) {
      throw new InvalidTokenError('Invalid API key');
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new InvalidTokenError('API key expired');
    }

    // Telemetry write — throttled so heavy agent traffic doesn't hammer
    // the row. Only one update per minute per key, regardless of QPS.
    const now = new Date();
    const stale =
      !apiKey.lastUsedAt ||
      now.getTime() - apiKey.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS;
    if (stale) {
      this.prisma.apiKey
        .update({
          where: { id: apiKey.id },
          data: {
            lastUsedAt: now,
            lastUsedIp: request.ip ?? null,
            lastUsedUa: request.headers['user-agent']?.slice(0, 500) ?? null,
            callCount: { increment: 1 },
          },
        })
        .catch(() => {});
    }

    request.user = {
      businessId: apiKey.businessId,
      role: 'AGENT',
      authType: 'apikey',
    };
    // Key prefix is the authoritative source of mode — `agnt_test_*`
    // routes to the test partition, `agnt_live_*` (or legacy plain) to
    // live. Stripe's pattern: the key IS the mode binding.
    const isTest = key.startsWith('agnt_test_');
    this.cls.set('businessId', apiKey.businessId);
    this.cls.set('role', 'AGENT');
    this.cls.set('apiKeyId', apiKey.id);
    this.cls.set('authMethod', 'apikey');
    this.cls.set('isTest', isTest);
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }

  private extractTokenFromCookie(request: Request): string | undefined {
    const cookies = (request as { cookies?: Record<string, string> }).cookies;
    return cookies?.['access_token'];
  }
}
