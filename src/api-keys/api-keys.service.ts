import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';
import { NotFoundError } from '../common/errors/index.js';
import { CreateApiKeyDto } from './dto/create-api-key.dto.js';
import { RotateApiKeyDto } from './dto/rotate-api-key.dto.js';
import { mintApiKey, type ApiKeyEnv } from './utils/api-key-format.js';

const DEFAULT_GRACE_SECONDS = 3_600; // 1h overlap when rotating

/**
 * Multi-tenant API Key admin service. OWNER-only — controller enforces
 * via `@Roles`.
 *
 * Read shape returned by list / get omits the plaintext (which never
 * exists at rest) and the `keyHash` (security). The plaintext is only
 * present in `create` and `rotate` responses, exactly once.
 */
@Injectable()
export class ApiKeysService extends BaseTenantService {
  constructor(prisma: PrismaService, cls: ClsService) {
    super(prisma, cls);
  }

  /**
   * Mint a new key. Returns the plaintext exactly once — never recoverable
   * after this response.
   */
  async create(dto: CreateApiKeyDto, createdById?: string) {
    // Caller chooses explicitly. Default `live` — Stripe UX, and the
    // less-surprising choice for default automation (e.g. onboarding
    // scripts that don't think about mode). Test mode is opt-in.
    const env: ApiKeyEnv = dto.mode ?? 'live';
    const minted = mintApiKey(env);

    const created = await this.prisma.db.apiKey.create({
      data: {
        name: dto.name,
        keyHash: minted.keyHash,
        prefix: minted.prefix,
        last4: minted.last4,
        createdById: createdById ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      } as never,
    });

    return {
      id: created.id,
      name: created.name,
      key: minted.plaintext, // ⚠ Shown once. Never returned again.
      prefix: created.prefix,
      last4: created.last4,
      expiresAt: created.expiresAt,
      createdAt: created.createdAt,
    };
  }

  /** List all keys for the tenant. Plaintext is never included. */
  async findAll() {
    const rows = await this.prisma.db.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toRedacted(r));
  }

  async findOne(id: string) {
    const row = await this.prisma.db.apiKey.findFirst({ where: { id } });
    if (!row) {
      throw new NotFoundError('API key not found', [
        { field: 'id', code: 'not_found', message: `No api key ${id}` },
      ]);
    }
    return this.toRedacted(row);
  }

  /**
   * Soft-delete: marks `revokedAt`/`isActive=false` so the key stops
   * authenticating immediately, but the row is kept for forensics
   * (last-used IP / UA / call count).
   */
  async revoke(id: string, revokedById?: string) {
    const row = await this.prisma.db.apiKey.findFirst({ where: { id } });
    if (!row) {
      throw new NotFoundError('API key not found', [
        { field: 'id', code: 'not_found', message: `No api key ${id}` },
      ]);
    }
    if (row.revokedAt) {
      // Idempotent — already revoked, return current state.
      return this.toRedacted(row);
    }
    const updated = await this.prisma.db.apiKey.update({
      where: { id },
      data: {
        isActive: false,
        revokedAt: new Date(),
        revokedById: revokedById ?? null,
      } as never,
    });
    return this.toRedacted(updated);
  }

  /**
   * Mint a new key while leaving the old one valid for `graceSeconds`
   * (default 1h, max 7d). The old key's `expiresAt` is rewritten to
   * `now + graceSeconds`. Lets a customer deploy the new key, verify
   * traffic, then let the old one expire — zero downtime rotation.
   */
  async rotate(id: string, dto: RotateApiKeyDto, actorId?: string) {
    const old = await this.prisma.db.apiKey.findFirst({ where: { id } });
    if (!old) {
      throw new NotFoundError('API key not found', [
        { field: 'id', code: 'not_found', message: `No api key ${id}` },
      ]);
    }

    const grace = dto.graceSeconds ?? DEFAULT_GRACE_SECONDS;
    const newExpiry = new Date(Date.now() + grace * 1_000);

    // Cap the OLD key's lifetime at the grace window. If it already
    // expires sooner, leave that earlier time in place.
    if (!old.expiresAt || old.expiresAt > newExpiry) {
      await this.prisma.db.apiKey.update({
        where: { id: old.id },
        data: { expiresAt: newExpiry } as never,
      });
    }

    return this.create(
      {
        name: `${old.name} (rotated)`,
        ...(old.expiresAt ? { expiresAt: old.expiresAt.toISOString() } : {}),
      },
      actorId,
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private toRedacted(row: {
    id: string;
    name: string;
    prefix: string;
    last4: string;
    isActive: boolean;
    createdAt: Date;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    lastUsedIp: string | null;
    revokedAt: Date | null;
    callCount: number;
  }) {
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      last4: row.last4,
      isActive: row.isActive,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      lastUsedIp: row.lastUsedIp,
      revokedAt: row.revokedAt,
      callCount: row.callCount,
    };
  }
}
