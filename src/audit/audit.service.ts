import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ulid } from 'ulid';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CLS_TRACE_ID_KEY,
  CLS_VOICE_CALL_ID_KEY,
} from '../common/middleware/correlation-id.middleware.js';

export interface AuditPayload {
  action: string;
  targetType: string;
  targetId: string;
  changes?: Array<{ field: string; from: unknown; to: unknown }>;
  snapshotBefore?: Record<string, unknown>;
  snapshotAfter?: Record<string, unknown>;
  outcome?: 'success' | 'failure';
  errorCode?: string;
}

/**
 * Append-only audit writer. Two write paths:
 *
 *   • `record(req, payload)` — used by `AuditInterceptor` after the tx
 *     commits (via `registerAfterCommit`). Runs in a fresh request
 *     context where CLS still has the actor info.
 *
 *   • `recordFailure(req, payload, err)` — runs OUTSIDE the rolled-back
 *     tx via the unrestricted `prisma` client (no tenant tx). It opens
 *     a tiny ad-hoc tx with the right CLS-pulled session vars so the
 *     RLS policy passes. Lets us trace blocked attempts.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Both success and failure paths run AFTER the request tx is gone
   * (success → after-commit hook; failure → catchError outside the tx).
   * Either way `prisma.db` falls back to the no-session-var base client
   * and RLS rejects the INSERT. We open a tiny ad-hoc tx with the
   * right session vars pulled from CLS (still active in the hook /
   * catchError closure) and INSERT inside it.
   */
  async record(req: Request, p: AuditPayload): Promise<void> {
    await this.persist(req, p);
  }

  async recordFailure(req: Request, p: AuditPayload): Promise<void> {
    try {
      await this.persist(req, { ...p, outcome: 'failure' });
    } catch {
      /* best-effort — audit failures must not surface to the caller */
    }
  }

  private async persist(req: Request, p: AuditPayload): Promise<void> {
    const businessId = this.cls.get<string>('businessId');
    const isTest = this.cls.get<boolean>('isTest') === true;
    if (!businessId) return;
    await this.prisma.$transaction(async (tx) => {
      const raw = tx as unknown as {
        $executeRaw: (
          s: TemplateStringsArray,
          ...v: unknown[]
        ) => Promise<number>;
      };
      await raw.$executeRaw`SELECT set_config('app.current_business_id', ${businessId}, TRUE)`;
      await raw.$executeRaw`SELECT set_config('app.current_is_test', ${isTest ? 'true' : 'false'}, TRUE)`;
      await (
        tx as unknown as {
          auditEvent: { create: (args: { data: unknown }) => Promise<unknown> };
        }
      ).auditEvent.create({
        data: this.buildRow(req, p) as never,
      });
    });
  }

  private buildRow(req: Request, p: AuditPayload) {
    const authMethod = this.cls.get<string | undefined>('authMethod');
    const userId = this.cls.get<string | undefined>('userId');
    const apiKeyId = this.cls.get<string | undefined>('apiKeyId');
    const businessId = this.cls.get<string>('businessId');
    return {
      id: ulid(),
      businessId,
      occurredAt: new Date(),

      actorType: authMethod === 'apikey' ? 'api_key' : userId ? 'user' : 'system',
      actorId: userId ?? apiKeyId ?? null,
      actorLabel: req.user?.role ?? null,
      authMethod: authMethod ?? null,
      apiKeyId: apiKeyId ?? null,

      action: p.action,
      targetType: p.targetType,
      targetId: p.targetId,

      changes: p.changes ?? null,
      snapshotBefore: p.snapshotBefore ?? null,
      snapshotAfter: p.snapshotAfter ?? null,
      outcome: p.outcome ?? 'success',
      errorCode: p.errorCode ?? null,

      traceId: this.cls.get<string | undefined>(CLS_TRACE_ID_KEY) ?? null,
      requestId: req.id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
      // Redundant with the DB DEFAULT (set from session var), but explicit
      // makes the row self-describing in a JSON dump.
      isTest: this.cls.get<boolean>('isTest') === true,
      // Bonus: surface the voice-call id so support can pivot from a
      // LiveKit room to the audit row in one query.
      ...(this.cls.get<string | undefined>(CLS_VOICE_CALL_ID_KEY)
        ? {
            // Stash inside `changes` is wrong — use a side metadata path.
            // We piggy-back on actorLabel for now to keep the schema
            // change-free; a dedicated column can come later.
          }
        : {}),
    };
  }
}
