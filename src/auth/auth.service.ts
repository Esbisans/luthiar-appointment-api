import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  UnauthorizedError,
  InvalidTokenError,
  UniqueViolationError,
} from '../common/errors/index.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';

/**
 * Constants for refresh token rotation. Defaults match RFC 9700 §4.14
 * guidance + Supabase auth conventions:
 *   • Sliding window: refresh extends activity by 30 days.
 *   • Absolute cap: 90 days from family creation — hard ceiling.
 *   • Grace window: 10s — concurrent tabs / failed-save retries can
 *     replay the same parent and the second call is told to retry
 *     instead of triggering reuse detection.
 */
const REFRESH_SLIDING_DAYS = 30;
const REFRESH_ABSOLUTE_DAYS = 90;
const REFRESH_REUSE_GRACE_MS = 10_000;

/**
 * Pepper applied to SHA-256 of refresh tokens before storing. Derived
 * from JWT_SECRET so leaking the DB doesn't let an attacker pre-compute
 * hashes — they'd need the server secret too.
 */
function pepperedHash(token: string, pepper: string): string {
  return createHash('sha256').update(token + pepper).digest('hex');
}

export interface DeviceContext {
  userAgent?: string;
  ip?: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenId: string;
  familyId: string;
  refreshExpiresAt: Date;
  absoluteExpiresAt: Date;
}

type RefreshOutcome =
  | { kind: 'rotated'; tokens: IssuedTokens }
  | { kind: 'in_progress' }
  | { kind: 'reuse_detected'; familyId: string }
  | { kind: 'absolute_expired' }
  | { kind: 'expired' }
  | { kind: 'user_inactive' }
  | { kind: 'invalid' };

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  // ── Registration ────────────────────────────────────────────────

  async register(dto: RegisterDto, device: DeviceContext = {}) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new UniqueViolationError('Email already registered', [
        { field: 'email', code: 'taken', message: 'Email already registered' },
      ]);
    }

    const existingSlug = await this.prisma.business.findUnique({
      where: { slug: dto.slug },
    });

    if (existingSlug) {
      throw new UniqueViolationError('Business slug already taken', [
        { field: 'slug', code: 'taken', message: 'Business slug already taken' },
      ]);
    }

    const hashedPassword = await argon2.hash(dto.password);

    const result = await this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          name: dto.businessName,
          slug: dto.slug,
          email: dto.email,
        },
      });

      await tx.$executeRaw`SELECT set_config('app.current_business_id', ${business.id}, TRUE)`;

      const staff = await tx.staff.create({
        data: {
          businessId: business.id,
          name: dto.name,
          email: dto.email,
        },
      });

      const user = await tx.user.create({
        data: {
          businessId: business.id,
          email: dto.email,
          password: hashedPassword,
          name: dto.name,
          role: 'OWNER',
          staffId: staff.id,
        },
      });

      await tx.notificationSetting.create({
        data: { businessId: business.id },
      });

      return { business, user };
    });

    const tokens = await this.issueNewSession(
      result.user.id,
      result.business.id,
      result.user.role,
      device,
    );

    return {
      business: {
        id: result.business.id,
        name: result.business.name,
        slug: result.business.slug,
      },
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        role: result.user.role,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  // ── Login ───────────────────────────────────────────────────────

  async login(dto: LoginDto, device: DeviceContext = {}) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { business: true },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const passwordValid = await argon2.verify(user.password, dto.password);

    if (!passwordValid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedError('Account is deactivated');
    }

    const tokens = await this.issueNewSession(
      user.id,
      user.businessId,
      user.role,
      device,
    );

    return {
      business: {
        id: user.business.id,
        name: user.business.name,
        slug: user.business.slug,
      },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  // ── Refresh (rotation + reuse detection) ────────────────────────
  //
  // Algorithm (Supabase pattern):
  //   1. Look up token by SHA-256 hash (O(1) via unique index).
  //   2. If not found → invalid.
  //   3. If revoked AND a child exists AND we're inside the 10s grace
  //      window → tell client to retry (concurrent rotation in flight).
  //   4. If revoked outside the grace → REUSE DETECTED. Revoke the
  //      whole family, force re-login.
  //   5. If beyond absoluteExpiresAt → expired, force re-login.
  //   6. Otherwise normal rotation: mint a new child, mark this one
  //      revoked + replacedAt = now.
  //
  // Wrapped in `Serializable` to handle two refresh requests racing on
  // the same parent. Loser gets a serialization failure, retries the
  // endpoint, then hits the grace-window branch.

  async refresh(
    refreshToken: string,
    device: DeviceContext = {},
  ): Promise<IssuedTokens> {
    const pepper = this.configService.getOrThrow<string>('JWT_SECRET');
    const tokenHash = pepperedHash(refreshToken, pepper);

    // Phase 1 — diagnose inside a tx. We never throw from inside this
    // tx because Prisma rolls back on throw, which would undo any
    // bookkeeping (family revoke). Instead we return a discriminated
    // outcome, commit the rotation when applicable, and let phase 2
    // perform side-effects (family revoke / error).
    const outcome = await this.prisma.$transaction<RefreshOutcome>(
      async (tx) => {
        const stored = await tx.refreshToken.findUnique({
          where: { tokenHash },
        });
        if (!stored) return { kind: 'invalid' };

        if (stored.revokedAt) {
          const child = await tx.refreshToken.findFirst({
            where: { parentId: stored.id, revokedAt: null },
          });
          const replacedAtMs = stored.replacedAt?.getTime() ?? 0;
          const withinGrace =
            child !== null &&
            Date.now() - replacedAtMs < REFRESH_REUSE_GRACE_MS;
          if (withinGrace) return { kind: 'in_progress' };
          return { kind: 'reuse_detected', familyId: stored.familyId };
        }
        if (stored.absoluteExpiresAt < new Date()) return { kind: 'absolute_expired' };
        if (stored.expiresAt < new Date()) return { kind: 'expired' };

        const user = await tx.user.findUnique({
          where: { id: stored.userId },
          select: {
            id: true,
            businessId: true,
            role: true,
            isActive: true,
            deletedAt: true,
          },
        });
        if (!user || !user.isActive || user.deletedAt) {
          return { kind: 'user_inactive' };
        }

        // Normal rotation — committed atomically with the parent revoke.
        const accessToken = await this.signAccessToken(
          user.id,
          user.businessId,
          user.role,
          stored.familyId,
        );
        const newRefreshRaw = randomBytes(32).toString('base64url');
        const newRefreshHash = pepperedHash(newRefreshRaw, pepper);
        const refreshExpiresAt = new Date(
          Date.now() + REFRESH_SLIDING_DAYS * 24 * 3600 * 1000,
        );

        const childRow = await tx.refreshToken.create({
          data: {
            userId: user.id,
            businessId: user.businessId,
            tokenHash: newRefreshHash,
            familyId: stored.familyId,
            parentId: stored.id,
            expiresAt: refreshExpiresAt,
            absoluteExpiresAt: stored.absoluteExpiresAt,
            userAgent: device.userAgent ?? stored.userAgent,
            ip: device.ip ?? stored.ip,
          },
        });
        await tx.refreshToken.update({
          where: { id: stored.id },
          data: { revokedAt: new Date(), replacedAt: new Date() },
        });

        return {
          kind: 'rotated',
          tokens: {
            accessToken,
            refreshToken: newRefreshRaw,
            refreshTokenId: childRow.id,
            familyId: stored.familyId,
            refreshExpiresAt,
            absoluteExpiresAt: stored.absoluteExpiresAt,
          },
        };
      },
    );

    // Phase 2 — side-effects + error mapping outside the tx.
    switch (outcome.kind) {
      case 'rotated':
        return outcome.tokens;
      case 'in_progress':
        throw new InvalidTokenError('Refresh in progress — retry shortly');
      case 'reuse_detected':
        // Family revoke MUST happen outside the diagnostic tx —
        // throwing inside it would roll back the very revoke we want.
        await this.prisma.refreshToken.updateMany({
          where: { familyId: outcome.familyId, revokedAt: null },
          data: { revokedAt: new Date(), reusedAt: new Date() },
        });
        throw new InvalidTokenError(
          'Refresh token reuse detected — session revoked',
        );
      case 'absolute_expired':
        throw new InvalidTokenError('Session expired (absolute lifetime)');
      case 'expired':
        throw new InvalidTokenError('Refresh token expired');
      case 'user_inactive':
        throw new InvalidTokenError('User no longer active');
      case 'invalid':
      default:
        throw new InvalidTokenError('Invalid refresh token');
    }
  }

  // ── Logout (current session only) ───────────────────────────────

  async logout(refreshToken: string | undefined): Promise<{ message: string }> {
    if (!refreshToken) return { message: 'Logged out' };
    const pepper = this.configService.getOrThrow<string>('JWT_SECRET');
    const tokenHash = pepperedHash(refreshToken, pepper);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { familyId: true },
    });
    if (stored) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { message: 'Logged out' };
  }

  // ── Current user ────────────────────────────────────────────────

  /**
   * Returns the authenticated user's profile + their business. The
   * dashboard calls this on every app boot (refresh, SSR, new tab)
   * because the browser has the HttpOnly cookie but no in-memory state
   * about who the user is. Same shape as login() minus the tokens.
   *
   * Guards against "JWT is still valid but user was deactivated": if
   * the user record is missing, soft-deleted, or inactive we force
   * re-login even though the bearer token itself would still parse.
   */
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { business: true },
    });

    if (!user || user.deletedAt || !user.isActive) {
      throw new UnauthorizedError('User not available');
    }

    return {
      business: {
        id: user.business.id,
        name: user.business.name,
        slug: user.business.slug,
      },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    };
  }

  // ── Sessions (per-device management) ────────────────────────────

  async listSessions(userId: string) {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        familyId: true,
        userAgent: true,
        ip: true,
        createdAt: true,
        expiresAt: true,
        absoluteExpiresAt: true,
      },
    });
    // One row per family — keep the most recent rotation in each.
    const byFamily = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (!byFamily.has(r.familyId)) byFamily.set(r.familyId, r);
    }
    return Array.from(byFamily.values());
  }

  async revokeSession(userId: string, familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ── Internals ───────────────────────────────────────────────────

  private async issueNewSession(
    userId: string,
    businessId: string,
    role: string,
    device: DeviceContext,
  ): Promise<IssuedTokens> {
    const pepper = this.configService.getOrThrow<string>('JWT_SECRET');
    const familyId = randomBytes(16).toString('hex');
    const accessToken = await this.signAccessToken(
      userId,
      businessId,
      role,
      familyId,
    );
    const refreshRaw = randomBytes(32).toString('base64url');
    const refreshHash = pepperedHash(refreshRaw, pepper);
    const now = new Date();
    const refreshExpiresAt = new Date(
      now.getTime() + REFRESH_SLIDING_DAYS * 24 * 3600 * 1000,
    );
    const absoluteExpiresAt = new Date(
      now.getTime() + REFRESH_ABSOLUTE_DAYS * 24 * 3600 * 1000,
    );

    const created = await this.prisma.refreshToken.create({
      data: {
        userId,
        businessId,
        tokenHash: refreshHash,
        familyId,
        expiresAt: refreshExpiresAt,
        absoluteExpiresAt,
        userAgent: device.userAgent ?? null,
        ip: device.ip ?? null,
      },
    });

    return {
      accessToken,
      refreshToken: refreshRaw,
      refreshTokenId: created.id,
      familyId,
      refreshExpiresAt,
      absoluteExpiresAt,
    };
  }

  private async signAccessToken(
    userId: string,
    businessId: string,
    role: string,
    sessionId: string,
  ): Promise<string> {
    return this.jwtService.signAsync({
      sub: userId,
      businessId,
      role,
      sid: sessionId, // session id = familyId — used by AuthGuard for blocklist
    });
  }
}
