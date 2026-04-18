import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import * as Sentry from '@sentry/nestjs';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
import {
  DomainError,
  ErrorCode,
  ErrorCodeValue,
  ErrorDetail,
} from '../errors/index.js';
import { CLS_TRACE_ID_KEY } from '../middleware/correlation-id.middleware.js';

interface MappedError {
  status: number;
  code: ErrorCodeValue;
  message: string;
  details?: ErrorDetail[] | Record<string, unknown>;
  /** Message included in server logs — may leak internals; never to client. */
  logMessage: string;
}

interface ErrorResponseBody {
  error: {
    /**
     * Stable URN identifier for the problem type (RFC 9457 §3.1
     * `type` member). Format: `urn:agent-saas:problems:<kebab-code>`.
     * Chosen over a pseudo-URL because RFC 9457 explicitly allows
     * non-dereferenceable URIs and a URN is honest — clients won't
     * try to navigate to it. When we ship a public docs site
     * (Fase 9, see deferred-work D86) we'll switch the namespace to
     * `https://docs.mibooking.com/errors/<code>` and that page will
     * actually resolve.
     */
    type: string;
    /**
     * Short human-readable summary derived from the HTTP status —
     * stable across error codes ("Unprocessable Entity"). RFC 9457
     * `title` member. Frontends can display this without knowing the
     * specific `code`.
     */
    title: string;
    /** Application-specific machine-readable code (extension). */
    code: ErrorCodeValue;
    /** Human-readable details for THIS occurrence (RFC 9457 `detail`). */
    message: string;
    status: number;
    details?: ErrorDetail[] | Record<string, unknown>;
    traceId: string | undefined;
    timestamp: string;
  };
}

/**
 * Short title per HTTP status. Stays constant for a given status
 * regardless of the specific `code`, matching RFC 9457 semantics
 * ("title SHOULD NOT change from occurrence to occurrence ...").
 */
const HTTP_STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * `VALIDATION_FAILED` → `validation-failed`.
 * Pure transform — no exotic chars expected since codes are SCREAMING_SNAKE.
 */
function codeToKebab(code: string): string {
  return code.toLowerCase().replace(/_/g, '-');
}

const PROBLEM_URN_PREFIX = 'urn:agent-saas:problems';

/**
 * Single translator for every thrown value in the app. Catches DomainError,
 * HttpException, Prisma errors, raw Postgres errors (RLS), and anything else.
 * Emits a stable `application/problem+json` response shape and logs at the
 * right level (warn for 4xx, error for 5xx).
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    @InjectPinoLogger(GlobalExceptionFilter.name)
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const traceId = this.cls.get<string>(CLS_TRACE_ID_KEY);

    const mapped = this.map(exception);

    const body: ErrorResponseBody = {
      error: {
        type: `${PROBLEM_URN_PREFIX}:${codeToKebab(mapped.code)}`,
        title: HTTP_STATUS_TITLES[mapped.status] ?? 'Error',
        code: mapped.code,
        message: mapped.message,
        status: mapped.status,
        ...(mapped.details !== undefined && { details: mapped.details }),
        traceId,
        timestamp: new Date().toISOString(),
      },
    };

    if (mapped.status >= 500) {
      this.logger.error(
        { err: exception, code: mapped.code, traceId },
        mapped.logMessage,
      );
      // Sentry.init is a no-op when SENTRY_DSN is unset, so captureException
      // is effectively skipped in dev/CI. In prod it reports to the project
      // dashboard with our traceId/tenant/code as tags.
      Sentry.captureException(exception, {
        tags: { code: mapped.code },
        extra: {
          traceId,
          tenantId: this.cls.get<string>('businessId'),
          userId: this.cls.get<string>('userId'),
        },
      });
    } else {
      this.logger.warn(
        { code: mapped.code, traceId },
        mapped.logMessage,
      );
    }

    res.setHeader('Content-Type', 'application/problem+json');
    res.status(mapped.status).json(body);
  }

  private map(e: unknown): MappedError {
    if (e instanceof DomainError) {
      return {
        status: e.httpStatus,
        code: e.code,
        message: e.message,
        details: e.details,
        logMessage: `${e.name}: ${e.message}`,
      };
    }

    // Express body-parser `PayloadTooLargeError` is a plain `Error` with
    // `.type === 'entity.too.large'` and `.status === 413`. It is NOT a
    // Nest HttpException — without this branch it falls to the generic
    // 500 catch-all and the client never learns it sent something too
    // big. Surface it with a real 413 + actionable details.
    if (this.isPayloadTooLarge(e)) {
      const err = e as { limit?: number; length?: number };
      return {
        status: 413,
        code: ErrorCode.PAYLOAD_TOO_LARGE,
        message: 'Request body too large',
        details: {
          ...(typeof err.limit === 'number' && { limitBytes: err.limit }),
          ...(typeof err.length === 'number' && { receivedBytes: err.length }),
        },
        logMessage: `Payload too large: ${err.length ?? '?'} > ${err.limit ?? '?'} bytes`,
      };
    }

    if (this.isPgRlsError(e)) {
      return {
        status: 403,
        code: ErrorCode.TENANT_ISOLATION_VIOLATION,
        message: 'Access denied',
        logMessage: `RLS violation: ${(e as Error)?.message}`,
      };
    }

    // SQLSTATE 57014 = `query_canceled`. Fired when Postgres's
    // `statement_timeout` trips. Surface as 504 — the DB refused the
    // request inside the declared budget, same semantics as an upstream
    // gateway timeout.
    if (this.isPgStatementTimeout(e)) {
      return {
        status: 504,
        code: ErrorCode.STATEMENT_TIMEOUT,
        message: 'Query exceeded time limit',
        logMessage: `statement_timeout (57014): ${(e as Error)?.message}`,
      };
    }

    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrismaKnown(e);
    }

    if (e instanceof Prisma.PrismaClientValidationError) {
      return {
        status: 400,
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Invalid query shape',
        logMessage: `PrismaValidation: ${e.message}`,
      };
    }

    if (e instanceof HttpException) {
      return this.mapHttp(e);
    }

    const err = e as Error;
    return {
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Something went wrong',
      logMessage: err?.message ?? 'Unknown error',
    };
  }

  private mapPrismaKnown(
    e: Prisma.PrismaClientKnownRequestError,
  ): MappedError {
    const table =
      typeof (e.meta as { modelName?: string })?.modelName === 'string'
        ? (e.meta as { modelName?: string }).modelName
        : undefined;

    const prismaMap: Record<
      string,
      Omit<MappedError, 'logMessage'> & { clientMessage: string }
    > = {
      P2002: {
        status: 409,
        code: ErrorCode.UNIQUE_VIOLATION,
        message: 'Resource already exists',
        clientMessage: 'Resource already exists',
        details: {
          target: (e.meta as { target?: string[] })?.target,
          ...(table && { model: table }),
        },
      },
      P2025: {
        status: 404,
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found',
        clientMessage: 'Resource not found',
      },
      P2003: {
        status: 409,
        code: ErrorCode.FK_VIOLATION,
        message: 'Related resource constraint violation',
        clientMessage: 'Related resource constraint violation',
      },
      P2034: {
        status: 409,
        code: ErrorCode.WRITE_CONFLICT,
        message: 'Write conflict, please retry',
        clientMessage: 'Write conflict, please retry',
      },
      P2028: {
        status: 503,
        code: ErrorCode.TX_TIMEOUT,
        message: 'Transaction timeout',
        clientMessage: 'Service temporarily unavailable',
      },
      P1001: {
        status: 503,
        code: ErrorCode.DB_UNREACHABLE,
        message: 'Database unreachable',
        clientMessage: 'Service temporarily unavailable',
      },
      P1008: {
        status: 503,
        code: ErrorCode.DB_TIMEOUT,
        message: 'Database timeout',
        clientMessage: 'Service temporarily unavailable',
      },
    };

    const hit = prismaMap[e.code];
    if (hit) {
      return {
        status: hit.status,
        code: hit.code,
        message: hit.clientMessage,
        details: hit.details,
        logMessage: `Prisma ${e.code}: ${e.message}`,
      };
    }
    return {
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Database error',
      logMessage: `Unmapped Prisma ${e.code}: ${e.message}`,
    };
  }

  private mapHttp(e: HttpException): MappedError {
    const status = e.getStatus();
    const response = e.getResponse();

    if (typeof response === 'object' && response !== null) {
      const r = response as {
        code?: ErrorCodeValue;
        message?: string | string[];
        details?: ErrorDetail[] | Record<string, unknown>;
      };
      const msg = Array.isArray(r.message)
        ? 'Validation failed'
        : (r.message ?? e.message);
      return {
        status,
        code: r.code ?? this.httpStatusToCode(status),
        message: msg,
        details:
          r.details ??
          (Array.isArray(r.message)
            ? r.message.map((m) => ({ message: m }))
            : undefined),
        logMessage: `${e.name}: ${msg}`,
      };
    }

    return {
      status,
      code: this.httpStatusToCode(status),
      message: typeof response === 'string' ? response : e.message,
      logMessage: `${e.name}: ${e.message}`,
    };
  }

  private httpStatusToCode(status: number): ErrorCodeValue {
    switch (status) {
      case 400:
        return ErrorCode.VALIDATION_FAILED;
      case 401:
        return ErrorCode.INVALID_TOKEN;
      case 403:
        return ErrorCode.FORBIDDEN;
      case 404:
        return ErrorCode.NOT_FOUND;
      case 409:
        return ErrorCode.CONFLICT;
      case 422:
        return ErrorCode.VALIDATION_FAILED;
      case 429:
        return ErrorCode.RATE_LIMIT_EXCEEDED;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }

  /**
   * RLS violations can surface as:
   *   1. Prisma wraps the pg error in PrismaClientUnknownRequestError —
   *      SQLSTATE ends up on `cause.code` OR in the message.
   *   2. The adapter passes the raw pg DatabaseError — `code === '42501'`.
   * See docs/prisma-quirks.md (Q10) for upstream tracking.
   */
  /**
   * Postgres `statement_timeout` fires with SQLSTATE `57014`. Prisma
   * wraps raw-query cancellations via `PrismaClientKnownRequestError`
   * (code P2010) with the original SQLSTATE on `cause.code` or
   * `meta.code`; client-engine-runtime surfaces it on `error.code` for
   * queries made through the adapter. We check all three shapes plus
   * the human-readable message as a last resort.
   */
  private isPgStatementTimeout(e: unknown): boolean {
    const err = e as {
      code?: string;
      cause?: { code?: string };
      meta?: { code?: string };
      message?: string;
    };
    if (err?.code === '57014') return true;
    if (err?.cause?.code === '57014') return true;
    if (err?.meta?.code === '57014') return true;
    if (
      typeof err?.message === 'string' &&
      err.message.includes('canceling statement due to statement timeout')
    ) {
      return true;
    }
    return false;
  }

  private isPayloadTooLarge(e: unknown): boolean {
    const err = e as {
      type?: string;
      status?: number;
      statusCode?: number;
    };
    return (
      err?.type === 'entity.too.large' ||
      err?.status === 413 ||
      err?.statusCode === 413
    );
  }

  private isPgRlsError(e: unknown): boolean {
    const err = e as {
      code?: string;
      message?: string;
      cause?: { code?: string };
    };
    if (err?.code === '42501') return true;
    if (err?.cause?.code === '42501') return true;
    if (
      typeof err?.message === 'string' &&
      err.message.toLowerCase().includes('row-level security')
    ) {
      return true;
    }
    return false;
  }
}
