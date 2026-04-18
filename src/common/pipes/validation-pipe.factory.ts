import { ValidationError as ClassValidatorError } from 'class-validator';
import { ValidationPipe } from '@nestjs/common';
import { ValidationError, ErrorDetail } from '../errors/index.js';

/**
 * Flattens class-validator's nested shape into a flat
 * `[{ field, code, message }]` array suitable for the client.
 *
 * class-validator returns objects that may have `children` (for nested
 * DTOs). We walk them, joining paths with '.' (e.g. `customer.phone`).
 */
function flattenValidationErrors(
  errors: ClassValidatorError[],
  parent = '',
): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  for (const err of errors) {
    const field = parent ? `${parent}.${err.property}` : err.property;
    if (err.constraints) {
      for (const [code, message] of Object.entries(err.constraints)) {
        out.push({ field, code, message });
      }
    }
    if (err.children && err.children.length > 0) {
      out.push(...flattenValidationErrors(err.children, field));
    }
  }
  return out;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
    stopAtFirstError: false,
    exceptionFactory: (errors) =>
      new ValidationError(
        'One or more fields failed validation',
        flattenValidationErrors(errors as ClassValidatorError[]),
      ),
  });
}
