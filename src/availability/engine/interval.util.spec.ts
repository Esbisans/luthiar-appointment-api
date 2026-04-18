import {
  contains,
  fitsIn,
  intersect,
  isNonEmpty,
  merge,
  overlaps,
  subtract,
  type Interval,
} from './interval.util.js';

const iv = (start: number, end: number): Interval => ({ start, end });

describe('interval.util', () => {
  describe('isNonEmpty', () => {
    it('true when start < end', () => {
      expect(isNonEmpty(iv(0, 1))).toBe(true);
    });
    it('false when start === end', () => {
      expect(isNonEmpty(iv(5, 5))).toBe(false);
    });
    it('false when start > end', () => {
      expect(isNonEmpty(iv(10, 5))).toBe(false);
    });
  });

  describe('overlaps', () => {
    it('true on partial overlap', () => {
      expect(overlaps(iv(0, 10), iv(5, 15))).toBe(true);
    });
    it('false when touching at end/start (half-open)', () => {
      expect(overlaps(iv(0, 10), iv(10, 20))).toBe(false);
    });
    it('true when one fully contains the other', () => {
      expect(overlaps(iv(0, 20), iv(5, 10))).toBe(true);
    });
    it('false when completely disjoint', () => {
      expect(overlaps(iv(0, 5), iv(10, 15))).toBe(false);
    });
  });

  describe('contains', () => {
    it('true when outer strictly contains inner', () => {
      expect(contains(iv(0, 20), iv(5, 15))).toBe(true);
    });
    it('true on equal bounds', () => {
      expect(contains(iv(0, 10), iv(0, 10))).toBe(true);
    });
    it('false when inner extends past outer', () => {
      expect(contains(iv(0, 10), iv(5, 15))).toBe(false);
    });
  });

  describe('merge', () => {
    it('empty → empty', () => {
      expect(merge([])).toEqual([]);
    });
    it('passes through a single interval', () => {
      expect(merge([iv(1, 2)])).toEqual([iv(1, 2)]);
    });
    it('drops empty intervals', () => {
      expect(merge([iv(0, 0), iv(5, 5)])).toEqual([]);
    });
    it('merges overlapping intervals', () => {
      expect(merge([iv(0, 10), iv(5, 12)])).toEqual([iv(0, 12)]);
    });
    it('merges touching intervals', () => {
      expect(merge([iv(0, 5), iv(5, 10)])).toEqual([iv(0, 10)]);
    });
    it('keeps disjoint intervals separate', () => {
      expect(merge([iv(0, 5), iv(10, 15)])).toEqual([iv(0, 5), iv(10, 15)]);
    });
    it('sorts unsorted input', () => {
      expect(merge([iv(20, 25), iv(0, 5), iv(10, 15)])).toEqual([
        iv(0, 5),
        iv(10, 15),
        iv(20, 25),
      ]);
    });
    it('does not mutate input array', () => {
      const input = [iv(5, 10), iv(0, 3)];
      merge(input);
      expect(input[0]).toEqual(iv(5, 10));
      expect(input[1]).toEqual(iv(0, 3));
    });
  });

  describe('intersect', () => {
    it('empty on no overlap', () => {
      expect(intersect([iv(0, 5)], [iv(10, 15)])).toEqual([]);
    });
    it('clips to common portion', () => {
      expect(intersect([iv(0, 10)], [iv(5, 15)])).toEqual([iv(5, 10)]);
    });
    it('multi-interval intersection', () => {
      expect(intersect([iv(0, 10), iv(15, 20)], [iv(5, 18)])).toEqual([
        iv(5, 10),
        iv(15, 18),
      ]);
    });
    it('identity on self', () => {
      const a = [iv(0, 10), iv(20, 30)];
      expect(intersect(a, a)).toEqual([iv(0, 10), iv(20, 30)]);
    });
  });

  describe('subtract', () => {
    it('returns base when minus is empty', () => {
      expect(subtract([iv(0, 10)], [])).toEqual([iv(0, 10)]);
    });
    it('empty base yields empty result', () => {
      expect(subtract([], [iv(0, 10)])).toEqual([]);
    });
    it('removes middle chunk', () => {
      expect(subtract([iv(0, 20)], [iv(5, 10)])).toEqual([iv(0, 5), iv(10, 20)]);
    });
    it('removes multiple chunks', () => {
      expect(
        subtract([iv(0, 20)], [iv(5, 10), iv(12, 15)]),
      ).toEqual([iv(0, 5), iv(10, 12), iv(15, 20)]);
    });
    it('fully covered base yields empty', () => {
      expect(subtract([iv(5, 10)], [iv(0, 20)])).toEqual([]);
    });
    it('leaves untouched intervals intact', () => {
      expect(
        subtract([iv(0, 5), iv(10, 15)], [iv(2, 4)]),
      ).toEqual([iv(0, 2), iv(4, 5), iv(10, 15)]);
    });
    it('touching boundaries do not slice', () => {
      // minus [10,20) touches base [0,10) at 10 → no slice produced
      expect(subtract([iv(0, 10)], [iv(10, 20)])).toEqual([iv(0, 10)]);
    });
  });

  describe('fitsIn', () => {
    it('true when slot fits strictly inside a free window', () => {
      expect(fitsIn([iv(0, 100)], iv(10, 90))).toBe(true);
    });
    it('true on exact boundary fit', () => {
      expect(fitsIn([iv(10, 20)], iv(10, 20))).toBe(true);
    });
    it('false when slot straddles a gap', () => {
      expect(fitsIn([iv(0, 10), iv(20, 30)], iv(5, 25))).toBe(false);
    });
    it('false when slot extends past free', () => {
      expect(fitsIn([iv(0, 10)], iv(5, 15))).toBe(false);
    });
    it('false when free is empty', () => {
      expect(fitsIn([], iv(0, 10))).toBe(false);
    });
  });
});
