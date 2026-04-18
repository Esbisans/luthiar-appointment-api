/**
 * Stable, machine-readable error codes returned to clients.
 *
 * Rules:
 *   • SCREAMING_SNAKE_CASE.
 *   • Never renamed once shipped — clients branch on these. Additions are
 *     fine; renames require a deprecation cycle.
 *   • Grouped by category (auth, tenant, validation, resource, …) as a
 *     human aid — not enforced in the string.
 */
export const ErrorCode = {
  // — Authentication / authorization
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_TOKEN: 'INVALID_TOKEN',
  FORBIDDEN: 'FORBIDDEN',
  TENANT_ISOLATION_VIOLATION: 'TENANT_ISOLATION_VIOLATION',

  // — Resources
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNIQUE_VIOLATION: 'UNIQUE_VIOLATION',
  FK_VIOLATION: 'FK_VIOLATION',

  // — Input
  VALIDATION_FAILED: 'VALIDATION_FAILED',

  // — Rate limiting / size limits
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  // — Infrastructure
  DB_UNREACHABLE: 'DB_UNREACHABLE',
  DB_TIMEOUT: 'DB_TIMEOUT',
  TX_TIMEOUT: 'TX_TIMEOUT',
  STATEMENT_TIMEOUT: 'STATEMENT_TIMEOUT',
  WRITE_CONFLICT: 'WRITE_CONFLICT',

  // — External dependencies
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',

  // — Catch-all
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
