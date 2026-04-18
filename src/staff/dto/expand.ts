/**
 * Reusable parser for the Stripe-style `?expand=a,b,c` query param.
 *
 * Returns a plain Set; consumers check membership. Unknown values are
 * silently ignored (permissive — matches Stripe/GitHub behaviour and avoids
 * breaking old clients when we add new expandable fields).
 */
export type StaffExpand = 'services' | 'availability' | 'blockedTimes' | 'user';

const ALLOWED: ReadonlySet<StaffExpand> = new Set<StaffExpand>([
  'services',
  'availability',
  'blockedTimes',
  'user',
]);

export function parseExpand(raw: unknown): Set<StaffExpand> {
  const out = new Set<StaffExpand>();
  if (typeof raw !== 'string' || raw.length === 0) return out;
  for (const token of raw.split(',').map((t) => t.trim())) {
    if ((ALLOWED as Set<string>).has(token)) out.add(token as StaffExpand);
  }
  return out;
}
