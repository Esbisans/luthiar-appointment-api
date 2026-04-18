/**
 * Half-open time intervals `[start, end)` on a millisecond timeline.
 *
 * All algorithms here are defensive against unsorted input, do NOT mutate
 * their arguments, and are O(n log n) dominated by a single sort. Pure —
 * no IO, no clock, no globals. Cheap to unit-test.
 */

export interface Interval {
  start: number; // ms since epoch
  end: number; // ms since epoch, exclusive
}

/** True if the interval is non-empty (start < end). */
export function isNonEmpty(i: Interval): boolean {
  return i.end > i.start;
}

/** True if `a` and `b` overlap at all. Touching endpoints do NOT overlap. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** True if `outer` fully contains `inner` (with equal bounds allowed). */
export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Merge overlapping / touching intervals. The output is sorted ascending.
 *
 *   merge([[0,10),[5,12),[15,20)]) = [[0,12),[15,20)]
 */
export function merge(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals]
    .filter(isNonEmpty)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

/**
 * Intersection of two (already-merged or arbitrary) interval sets.
 * Result is sorted and merged.
 *
 *   intersect([[0,10),[15,20)], [[5,18)]) = [[5,10),[15,18)]
 */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const A = merge(a);
  const B = merge(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const x = A[i]!;
    const y = B[j]!;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (start < end) out.push({ start, end });
    if (x.end < y.end) i++;
    else j++;
  }
  return out;
}

/**
 * Subtract `minus` from `base`. Returns the portions of `base` that are
 * NOT covered by any interval in `minus`.
 *
 *   subtract([[0,20)], [[5,10),[12,15)]) = [[0,5),[10,12),[15,20)]
 */
export function subtract(base: Interval[], minus: Interval[]): Interval[] {
  const B = merge(base);
  const M = merge(minus);
  const out: Interval[] = [];
  for (const b of B) {
    let cursor = b.start;
    for (const m of M) {
      if (m.end <= cursor) continue; // fully before
      if (m.start >= b.end) break; // fully after — rest of M too
      if (m.start > cursor) out.push({ start: cursor, end: m.start });
      cursor = Math.max(cursor, m.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}

/**
 * `true` if `fit` starts/ends inside any single interval of `free`.
 * (A slot must lie entirely within one free window — not straddle a gap.)
 */
export function fitsIn(free: Interval[], fit: Interval): boolean {
  for (const f of free) {
    if (contains(f, fit)) return true;
  }
  return false;
}
