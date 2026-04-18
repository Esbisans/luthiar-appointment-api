import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { Observable, catchError, tap, throwError } from 'rxjs';
import type { Request } from 'express';
import { registerAfterCommit } from '../common/transaction/after-commit.js';
import { AUDIT_META, AuditMeta } from './audit.decorator.js';
import { AuditService } from './audit.service.js';

/**
 * Auto-audit interceptor.
 *
 * On success: schedules an audit row via `registerAfterCommit` so it
 * only persists if the underlying transaction actually commits. The
 * row is written in the SAME tx via `prisma.db.auditEvent.create` —
 * mode + tenant inherited from the session vars set by
 * `TenantTxInterceptor`.
 *
 * On failure: writes an `outcome: 'failure'` row OUTSIDE the rolled
 * back tx (separate connection) so blocked attempts are visible.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService,
    private readonly audit: AuditService,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta>(AUDIT_META, context.getHandler());
    if (!meta) return next.handle();

    const req = context.switchToHttp().getRequest<Request>();

    return next.handle().pipe(
      tap((response: unknown) => {
        const targetId =
          meta.targetIdFrom === 'responseId'
            ? (response as { id?: string })?.id
            : ((req.params as Record<string, string> | undefined)?.['id'] ??
              (response as { id?: string })?.id);
        if (!targetId) return; // can't audit without a target
        const snapshotAfter = isPlainObject(response)
          ? (response as Record<string, unknown>)
          : undefined;
        registerAfterCommit(this.cls, () => {
          void this.audit.record(req, {
            action: meta.action,
            targetType: meta.targetType,
            targetId,
            ...(snapshotAfter ? { snapshotAfter } : {}),
          });
        });
      }),
      catchError((err: unknown) => {
        const targetId =
          (req.params as Record<string, string> | undefined)?.['id'] ??
          'unknown';
        const errorCode =
          (err as { code?: string })?.code ??
          (err as { name?: string })?.name ??
          'error';
        void this.audit.recordFailure(req, {
          action: meta.action,
          targetType: meta.targetType,
          targetId,
          outcome: 'failure',
          errorCode,
        });
        return throwError(() => err);
      }),
    );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
