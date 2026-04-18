import {
  cursorWhere,
  decodeCursor,
  encodeCursor,
  slicePage,
} from './cursor.util.js';

describe('cursor.util', () => {
  describe('encode / decode', () => {
    it('roundtrips', () => {
      const v = { t: '2026-04-17T10:00:00.000Z', i: '01KPC...' };
      expect(decodeCursor(encodeCursor(v))).toEqual(v);
    });

    it('rejects garbage', () => {
      expect(decodeCursor('not-base64')).toBeNull();
      expect(decodeCursor('')).toBeNull();
      expect(decodeCursor(Buffer.from('"plain string"').toString('base64url'))).toBeNull();
    });

    it('rejects invalid timestamp', () => {
      const bad = Buffer.from(JSON.stringify({ t: 'not-a-date', i: 'x' })).toString(
        'base64url',
      );
      expect(decodeCursor(bad)).toBeNull();
    });

    it('rejects missing fields', () => {
      const onlyT = Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00Z' })).toString(
        'base64url',
      );
      expect(decodeCursor(onlyT)).toBeNull();
    });
  });

  describe('cursorWhere', () => {
    it('produces the "strictly after (createdAt DESC, id DESC)" predicate', () => {
      const w = cursorWhere({ t: '2026-04-17T10:00:00.000Z', i: 'id-123' });
      expect(w).toEqual({
        OR: [
          { createdAt: { lt: new Date('2026-04-17T10:00:00.000Z') } },
          { createdAt: new Date('2026-04-17T10:00:00.000Z'), id: { lt: 'id-123' } },
        ],
      });
    });
  });

  describe('slicePage', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `row-${i}`,
      createdAt: new Date(`2026-04-17T10:0${i}:00Z`),
    }));

    it('returns has_more = false and no cursor when rows.length <= limit', () => {
      const r = slicePage(rows, 10);
      expect(r.has_more).toBe(false);
      expect(r.data).toHaveLength(5);
      expect(r.next_cursor).toBeNull();
    });

    it('returns has_more = true and a cursor when rows exceed limit', () => {
      const r = slicePage(rows, 3);
      expect(r.has_more).toBe(true);
      expect(r.data).toHaveLength(3);
      expect(r.next_cursor).not.toBeNull();
      const decoded = decodeCursor(r.next_cursor!);
      expect(decoded?.i).toBe('row-2'); // last row in the 3-row page
    });

    it('clamps limit to MAX_LIMIT', () => {
      const many = Array.from({ length: 120 }, (_, i) => ({
        id: `r${i}`,
        createdAt: new Date(`2026-04-17T10:00:00Z`),
      }));
      // Service hands 121 rows (take = 101 in practice; we test the slicer).
      const r = slicePage(many.slice(0, 101), 500 /* user asked for 500 */);
      expect(r.data).toHaveLength(100); // MAX_LIMIT
      expect(r.has_more).toBe(true);
    });
  });
});
