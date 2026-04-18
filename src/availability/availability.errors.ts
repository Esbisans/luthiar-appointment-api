import { ValidationError, NotFoundError, ConflictError } from '../common/errors/index.js';

/** Public-facing validation helpers so the domain layer stays transport-agnostic. */
export const AvailabilityErrors = {
  invalidRange(from: string, to: string): ValidationError {
    return new ValidationError('from must be on or before to', [
      { field: 'from', code: 'invalid_range', message: from },
      { field: 'to', code: 'invalid_range', message: to },
    ]);
  },
  rangeTooWide(maxDays: number): ValidationError {
    return new ValidationError(
      `Range too wide. Max ${maxDays} days per query`,
      [{ field: 'to', code: 'range_too_wide' }],
    );
  },
  invalidTimezone(tz: string): ValidationError {
    return new ValidationError(`Unknown timezone: ${tz}`, [
      { field: 'timezone', code: 'unknown_timezone', message: tz },
    ]);
  },
  serviceNotFound(id: string): NotFoundError {
    return new NotFoundError('Service not found', [
      { field: 'serviceId', code: 'not_found', message: id },
    ]);
  },
  staffCannotDoService(staffId: string, serviceId: string): ConflictError {
    return new ConflictError(
      'Requested staff does not offer this service',
      { staffId, serviceId },
    );
  },
};
