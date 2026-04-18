import {
  extractPrefix,
  hashKey,
  isValidKeyFormat,
  mintApiKey,
} from './api-key-format.js';

describe('api-key-format', () => {
  describe('mintApiKey', () => {
    it('generates a key with the agnt_live_ prefix and a checksum', () => {
      const k = mintApiKey('live');
      expect(k.plaintext.startsWith('agnt_live_')).toBe(true);
      expect(k.plaintext.length).toBeGreaterThan(40);
      expect(isValidKeyFormat(k.plaintext)).toBe(true);
    });

    it('test env uses agnt_test_', () => {
      const k = mintApiKey('test');
      expect(k.plaintext.startsWith('agnt_test_')).toBe(true);
    });

    it('returns a stable SHA-256 hash matching hashKey()', () => {
      const k = mintApiKey('live');
      expect(k.keyHash).toBe(hashKey(k.plaintext));
      expect(k.keyHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('prefix is the first 18 chars (agnt_live_<8>)', () => {
      const k = mintApiKey('live');
      expect(k.prefix.length).toBe(18);
      expect(k.prefix).toBe(k.plaintext.slice(0, 18));
    });

    it('successive mints produce unique plaintexts', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const k = mintApiKey('live');
        expect(seen.has(k.plaintext)).toBe(false);
        seen.add(k.plaintext);
      }
    });
  });

  describe('isValidKeyFormat', () => {
    it('accepts a freshly minted key', () => {
      const k = mintApiKey('live');
      expect(isValidKeyFormat(k.plaintext)).toBe(true);
    });

    it('rejects a key with a flipped char (CRC32 mismatch)', () => {
      const k = mintApiKey('live');
      // Flip a char inside the random body (not the checksum) — checksum
      // recomputation should mismatch.
      const tampered = k.plaintext.slice(0, 15) + 'Z' + k.plaintext.slice(16);
      expect(isValidKeyFormat(tampered)).toBe(false);
    });

    it('rejects garbage', () => {
      expect(isValidKeyFormat('not-a-key')).toBe(false);
      expect(isValidKeyFormat('agnt_live_xxxx')).toBe(false);
      expect(isValidKeyFormat('')).toBe(false);
    });

    it('rejects unknown env', () => {
      expect(isValidKeyFormat('agnt_prod_aaaaaaaaaaaaaaaa123456')).toBe(false);
    });
  });

  describe('extractPrefix', () => {
    it('returns the first 18 chars', () => {
      const k = mintApiKey('live');
      expect(extractPrefix(k.plaintext)).toBe(k.prefix);
    });
  });
});
