import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Keyset-pagination helper (Stripe / Linear / Shopify 2025 shape).
 *
 * Two decisions enshrined here:
 *
 *   1. **Opaque base64 cursor**. Encodes `{t: ISO_createdAt, i: id}` so
 *      we can sort on any field later without breaking clients that
 *      hold a cursor. Clients never parse the payload.
 *
 *   2. **Composite keyset (`createdAt`, `id`)**. Ties are possible on
 *      `createdAt` alone (same-millisecond inserts) — pair with `id` as
 *      a deterministic tiebreaker in both `orderBy` AND cursor
 *      comparison. Without the tiebreaker, page boundaries drift
 *      randomly under load. This is the single most common bug in
 *      hand-rolled cursor pagination.
 *
 * Response shape matches `/conversations` and `/audit`:
 *   `{ data, has_more, next_cursor }`
 *
 * Why not Prisma's built-in `cursor: {id}` + `skip: 1`?
 *   - Only supports single-column cursors.
 *   - Throws if the cursor row was deleted — a real race in a live
 *     dashboard. Keyset compares against the value, not the row.
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface CursorValue {
  /** ISO timestamp of the last row seen (sort field). */
  t: string;
  /** UUID of the last row seen (tiebreaker). */
  i: string;
}

export function encodeCursor(v: CursorValue): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

export function decodeCursor(raw: string): CursorValue | null {
  try {
    const d = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof d.t !== 'string' || typeof d.i !== 'string') return null;
    // Sanity check the timestamp.
    if (Number.isNaN(Date.parse(d.t))) return null;
    return { t: d.t, i: d.i };
  } catch {
    return null;
  }
}

/**
 * Build a Prisma `where` fragment that represents "strictly after the
 * cursor" under DESC ordering. `sortField` defaults to `createdAt`;
 * appointments override to `startTime` so the cursor matches the
 * ORDER BY (otherwise pages interleave inconsistently).
 *
 *   WHERE <sortField> < :t
 *      OR (<sortField> = :t AND id < :i)
 */
export function cursorWhere(cursor: CursorValue, sortField = 'createdAt') {
  return {
    OR: [
      { [sortField]: { lt: new Date(cursor.t) } },
      { [sortField]: new Date(cursor.t), id: { lt: cursor.i } },
    ],
  };
}

/**
 * Shared order-by factory. Index needed on `(businessId, <sortField> DESC,
 * id DESC)` so the planner picks an index scan (no Bitmap Heap Scan).
 */
export function keysetOrderBy(sortField = 'createdAt') {
  return [
    { [sortField]: 'desc' as const },
    { id: 'desc' as const },
  ];
}

export function takePlusOne(limit: number): number {
  return Math.min(MAX_LIMIT, Math.max(1, limit)) + 1;
}

export function slicePage<T extends { id: string }>(
  rows: T[],
  limit: number,
  sortField: keyof T = 'createdAt' as keyof T,
): { data: T[]; has_more: boolean; next_cursor: string | null } {
  const cap = Math.min(MAX_LIMIT, Math.max(1, limit));
  const has_more = rows.length > cap;
  const data = has_more ? rows.slice(0, cap) : rows;
  const last = data.at(-1);
  const sortVal = last ? (last[sortField] as unknown as Date) : null;
  const next_cursor =
    has_more && last && sortVal
      ? encodeCursor({ t: sortVal.toISOString(), i: last.id })
      : null;
  return { data, has_more, next_cursor };
}

// ── DTO pieces ─────────────────────────────────────────────────────

/**
 * Mixin-like base DTO. Endpoints extend this to get both cursor (new)
 * and page/limit (legacy) inputs during the migration window. Service
 * picks cursor path when `cursor` is present, falls back to offset
 * otherwise.
 */
export class CursorQueryDto {
  @ApiProperty({
    required: false,
    description:
      'Opaque cursor from the previous response\'s `next_cursor`. Mutually exclusive with `page`; if both are supplied, `cursor` wins.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, default: DEFAULT_LIMIT, maximum: MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number = DEFAULT_LIMIT;

  /** Legacy page-based pagination. Deprecated — migrate to `cursor`. */
  @ApiProperty({
    required: false,
    deprecated: true,
    description:
      'Legacy offset pagination. Retained for backward compatibility during the migration to cursor. New clients should use `cursor` instead.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
