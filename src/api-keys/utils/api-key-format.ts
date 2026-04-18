import { createHash, randomBytes } from 'crypto';

/**
 * Token format inspired by GitHub's 2021 redesign
 * (https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/):
 *
 *   `agnt_<env>_<32-byte-base62><6-char-CRC32>`
 *   ─┬── ─┬─ ─────────┬──────── ──────┬──────
 *    │    │           │              └─ checksum: clients can detect typos offline
 *    │    │           └─ random body (~190 bits entropy)
 *    │    └─ environment marker: `live` | `test` (helps secret scanners)
 *    └─ vendor prefix: makes the key recognisable by GitHub/GitLab secret-scanning
 *
 * Example: `agnt_live_3kJ8mP2qN7vR9xL4tBcF6yHwZdAeQs5g7uVnM3pK1jX2H4B7c8`
 *
 * Storage:
 *   • `keyHash` = SHA-256(plaintext) — keys are 190+ bits, brute-force-proof.
 *     Bcrypt/Argon2 add 10-100ms per request with zero security gain.
 *   • `prefix` = first 18 chars (`agnt_live_3kJ8mP2q`) for fast lookup + UI.
 *   • `last4` = last 4 chars before the checksum, for owner disambiguation.
 *
 * The plaintext is shown ONCE in the create response. Lost = rotate.
 */

const VENDOR_PREFIX = 'agnt';
const BASE62 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PREFIX_LENGTH = 18; // `agnt_live_<8 chars>`
const RANDOM_BODY_BYTES = 32; // → ~43 base62 chars (~190 bits entropy)
const CHECKSUM_LENGTH = 6;

export type ApiKeyEnv = 'live' | 'test';

export interface MintedKey {
  /** The plaintext token. Returned to the user ONCE. Never stored. */
  plaintext: string;
  /** SHA-256 of the plaintext, hex-encoded. Stored. */
  keyHash: string;
  /** First 18 chars (`agnt_live_<8>`). Stored. Safe to show in UI. */
  prefix: string;
  /** Last 4 chars before the checksum. Stored. */
  last4: string;
}

/** Generate a fresh API key. */
export function mintApiKey(env: ApiKeyEnv = 'live'): MintedKey {
  const body = base62Encode(randomBytes(RANDOM_BODY_BYTES));
  const head = `${VENDOR_PREFIX}_${env}_${body}`;
  const checksum = crc32Base62(head);
  const plaintext = `${head}${checksum}`;
  return {
    plaintext,
    keyHash: hashKey(plaintext),
    prefix: plaintext.slice(0, PREFIX_LENGTH),
    last4: body.slice(-4),
  };
}

/** SHA-256 hex of the plaintext. */
export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * True if the format and CRC32 checksum match. Lets the auth guard
 * reject obvious typos (and bots probing random strings) without a DB
 * round-trip.
 */
export function isValidKeyFormat(plaintext: string): boolean {
  if (typeof plaintext !== 'string') return false;
  const m = /^agnt_(live|test)_([A-Za-z0-9]+)([A-Za-z0-9]{6})$/.exec(plaintext);
  if (!m) return false;
  const head = plaintext.slice(0, plaintext.length - CHECKSUM_LENGTH);
  const expected = crc32Base62(head);
  return expected === m[3];
}

/** Extract the prefix without recomputing — for the lookup query. */
export function extractPrefix(plaintext: string): string {
  return plaintext.slice(0, PREFIX_LENGTH);
}

// ── Internals ──────────────────────────────────────────────────────────

function base62Encode(bytes: Buffer): string {
  // Encode as base62 by repeated division. Not the most efficient but
  // we only do it once per key creation (and never on the hot path).
  let n = BigInt('0x' + bytes.toString('hex'));
  if (n === 0n) return '0';
  const out: string[] = [];
  const base = 62n;
  while (n > 0n) {
    const r = Number(n % base);
    out.push(BASE62[r]!);
    n = n / base;
  }
  return out.reverse().join('');
}

/**
 * Standard CRC32 (polynomial 0xEDB88320), encoded as 6 base62 chars
 * (zero-padded). 32 bits → log62(2^32) ≈ 5.37 chars; 6 fits comfortably.
 */
function crc32Base62(input: string): string {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc = crc ^ input.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  let s = '';
  let n = BigInt(crc);
  while (n > 0n) {
    s = BASE62[Number(n % 62n)]! + s;
    n = n / 62n;
  }
  return s.padStart(CHECKSUM_LENGTH, '0');
}
