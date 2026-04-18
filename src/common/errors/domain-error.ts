import { ErrorCodeValue } from './error-codes.js';

/**
 * Field-level detail for validation errors or structured client messages.
 * `field` follows dotted-path convention (e.g. `customer.phone`).
 */
export interface ErrorDetail {
  field?: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Root class for every error thrown intentionally by the domain/service layer.
 *
 * Services throw `DomainError` subclasses; they never throw `HttpException`
 * directly. A single `GlobalExceptionFilter` translates these into HTTP
 * responses. This keeps the service layer transport-agnostic (reusable from
 * queues, CLI, tests) and the error shape consistent.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCodeValue;
  abstract readonly httpStatus: number;

  constructor(
    message: string,
    public readonly details?: ErrorDetail[] | Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
