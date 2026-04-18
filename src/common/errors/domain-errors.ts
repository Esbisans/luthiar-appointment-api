import { DomainError } from './domain-error.js';
import { ErrorCode, ErrorCodeValue } from './error-codes.js';

export class ValidationError extends DomainError {
  readonly code: ErrorCodeValue = ErrorCode.VALIDATION_FAILED;
  readonly httpStatus = 422;
}

export class NotFoundError extends DomainError {
  readonly code: ErrorCodeValue = ErrorCode.NOT_FOUND;
  readonly httpStatus = 404;
}

export class ConflictError extends DomainError {
  readonly code: ErrorCodeValue = ErrorCode.CONFLICT;
  readonly httpStatus = 409;
}

export class UniqueViolationError extends DomainError {
  readonly code: ErrorCodeValue = ErrorCode.UNIQUE_VIOLATION;
  readonly httpStatus = 409;
}

export class UnauthorizedError extends DomainError {
  readonly code: ErrorCodeValue = ErrorCode.INVALID_CREDENTIALS;
  readonly httpStatus = 401;
}

export class InvalidTokenError extends DomainError {
  readonly code: ErrorCodeValue = ErrorCode.INVALID_TOKEN;
  readonly httpStatus = 401;
}

export class ForbiddenError extends DomainError {
  readonly code: ErrorCodeValue = ErrorCode.FORBIDDEN;
  readonly httpStatus = 403;
}

export class TenantIsolationError extends DomainError {
  readonly code: ErrorCodeValue = ErrorCode.TENANT_ISOLATION_VIOLATION;
  readonly httpStatus = 403;
}

export class RateLimitError extends DomainError {
  readonly code: ErrorCodeValue = ErrorCode.RATE_LIMIT_EXCEEDED;
  readonly httpStatus = 429;
}

/**
 * Thrown when a third-party integration (Stripe, OpenAI, Meta, LiveKit) fails
 * in a way the user can't recover from — we surface 502 so clients treat it
 * as "upstream gateway unavailable" and consider retry logic.
 */
export class ExternalServiceError extends DomainError {
  readonly code: ErrorCodeValue = ErrorCode.EXTERNAL_SERVICE_ERROR;
  readonly httpStatus = 502;

  constructor(
    public readonly service: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}
