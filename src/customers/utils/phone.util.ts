import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js';
import { ValidationError } from '../../common/errors/index.js';

/**
 * Thin wrapper around libphonenumber-js for our three concrete needs:
 *   • Normalize any input to canonical E.164 (+525512345678)
 *   • Decide whether the number is actually possible for its country
 *   • Format for display in the national convention (optional, UI-side)
 *
 * All voice-agent / WhatsApp / dashboard inputs go through `toE164` before
 * reaching Prisma, so the unique constraint `(businessId, phone)` operates
 * on a single canonical form.
 */
export const DEFAULT_COUNTRY: CountryCode = 'MX';

export function toE164(raw: string, defaultCountry: CountryCode = DEFAULT_COUNTRY): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ValidationError('Phone is required', [
      { field: 'phone', code: 'required' },
    ]);
  }
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed || !parsed.isPossible()) {
    throw new ValidationError('Phone number is not valid', [
      {
        field: 'phone',
        code: 'invalid_format',
        message:
          'Phone must be a valid number — E.164 (+CountryCodeDigits) or a number from the default country.',
      },
    ]);
  }
  return parsed.number;
}

/**
 * Format an E.164 number for display using the national convention of its
 * detected country. Falls back to the raw string if parse fails (should
 * never happen if the value went through `toE164` first, but defensive).
 */
export function formatForDisplay(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed?.formatNational() ?? e164;
}
