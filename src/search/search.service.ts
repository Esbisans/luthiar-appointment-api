import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';

const MIN_QUERY_LEN = 2;
const MAX_PER_TYPE = 20;

export type SearchableType =
  | 'customer'
  | 'appointment'
  | 'conversation'
  | 'staff'
  | 'service';

export interface SearchHit {
  id: string;
  title: string;
  subtitle?: string | null;
  score: number;
}

export interface SearchResponse {
  query: string;
  results: {
    customers: SearchHit[];
    appointments: SearchHit[];
    conversations: SearchHit[];
    staff: SearchHit[];
    services: SearchHit[];
  };
  took_ms: number;
}

/**
 * Global search — mixed-entity results for a visible top-bar search bar.
 *
 * Design decisions:
 *   • Grouped response (Shopify shape), not a flat array — the UI renders
 *     per-type sections, and `similarity()` vs `ts_rank()` are not
 *     comparable in one sort anyway.
 *   • Per-type top-N, no cross-type global ranking. Keeps rank math simple
 *     and UX predictable.
 *   • pg_trgm for short fields (names, phones, emails) — typo-tolerant and
 *     cheap on small strings.
 *   • Stored-generated tsvector + `websearch_to_tsquery` for long fields
 *     (message transcripts, conversation summaries) — handles phrases,
 *     OR, exclusions; uses the pre-built GIN index.
 *   • `unaccent` chained everywhere so es-MX accents don't matter.
 *   • RLS handles tenant isolation automatically — we ONLY see rows of
 *     the caller's business (policy reads `app.current_business_id`).
 *   • Five queries in parallel via `Promise.all`. NOT wrapped in
 *     `$transaction` — that would serialise to one connection and defeat
 *     parallelism (see prisma/prisma#13134).
 */
@Injectable()
export class SearchService extends BaseTenantService {
  constructor(prisma: PrismaService, cls: ClsService) {
    super(prisma, cls);
  }

  async search(
    q: string,
    types: SearchableType[] | undefined,
    limit: number,
  ): Promise<SearchResponse> {
    const start = performance.now();
    const normalised = q.trim();
    if (normalised.length < MIN_QUERY_LEN) {
      return {
        query: q,
        results: {
          customers: [],
          appointments: [],
          conversations: [],
          staff: [],
          services: [],
        },
        took_ms: Math.round(performance.now() - start),
      };
    }

    const perType = Math.min(MAX_PER_TYPE, Math.max(1, limit));
    const wanted = new Set<SearchableType>(
      types && types.length > 0
        ? types
        : ['customer', 'appointment', 'conversation', 'staff', 'service'],
    );

    const [customers, appointments, conversations, staff, services] =
      await Promise.all([
        wanted.has('customer')
          ? this.searchCustomers(normalised, perType)
          : [],
        wanted.has('appointment')
          ? this.searchAppointments(normalised, perType)
          : [],
        wanted.has('conversation')
          ? this.searchConversations(normalised, perType)
          : [],
        wanted.has('staff') ? this.searchStaff(normalised, perType) : [],
        wanted.has('service')
          ? this.searchServices(normalised, perType)
          : [],
      ]);

    return {
      query: q,
      results: { customers, appointments, conversations, staff, services },
      took_ms: Math.round(performance.now() - start),
    };
  }

  // ── Per-entity queries ──────────────────────────────────────────
  //
  // Each runs `$queryRaw` so we get tsvector / unaccent / similarity
  // primitives Prisma Client doesn't expose. `prisma.db` carries the
  // tenant session var, so RLS auto-scopes — no explicit `businessId`
  // filter in the WHERE.

  private async searchCustomers(q: string, limit: number): Promise<SearchHit[]> {
    return this.prisma.db.$queryRawUnsafe<SearchHit[]>(
      `
      SELECT
        id,
        name AS title,
        COALESCE(phone, email) AS subtitle,
        GREATEST(
          similarity(immutable_unaccent(lower(name)),  immutable_unaccent(lower($1))),
          similarity(coalesce(phone, ''),              $1),
          similarity(immutable_unaccent(lower(coalesce(email,''))), immutable_unaccent(lower($1)))
        )::float AS score
      FROM "Customer"
      WHERE "deletedAt" IS NULL
        AND (
             immutable_unaccent(lower(name))  % immutable_unaccent(lower($1))
          OR phone                              % $1
          OR immutable_unaccent(lower(coalesce(email,''))) % immutable_unaccent(lower($1))
        )
      ORDER BY score DESC
      LIMIT $2
      `,
      q,
      limit,
    );
  }

  private async searchStaff(q: string, limit: number): Promise<SearchHit[]> {
    return this.prisma.db.$queryRawUnsafe<SearchHit[]>(
      `
      SELECT id,
             name AS title,
             NULL::text AS subtitle,
             similarity(immutable_unaccent(lower(name)), immutable_unaccent(lower($1)))::float AS score
      FROM "Staff"
      WHERE "deletedAt" IS NULL
        AND immutable_unaccent(lower(name)) % immutable_unaccent(lower($1))
      ORDER BY score DESC
      LIMIT $2
      `,
      q,
      limit,
    );
  }

  private async searchServices(q: string, limit: number): Promise<SearchHit[]> {
    return this.prisma.db.$queryRawUnsafe<SearchHit[]>(
      `
      SELECT id,
             name AS title,
             description AS subtitle,
             GREATEST(
               similarity(immutable_unaccent(lower(name)),        immutable_unaccent(lower($1))),
               similarity(immutable_unaccent(lower(coalesce(description, ''))), immutable_unaccent(lower($1)))
             )::float AS score
      FROM "Service"
      WHERE "deletedAt" IS NULL
        AND (
             immutable_unaccent(lower(name)) % immutable_unaccent(lower($1))
          OR immutable_unaccent(lower(coalesce(description, ''))) % immutable_unaccent(lower($1))
        )
      ORDER BY score DESC
      LIMIT $2
      `,
      q,
      limit,
    );
  }

  private async searchAppointments(q: string, limit: number): Promise<SearchHit[]> {
    // Appointment has no "title" of its own — we show the customer name
    // as the hit label and the startTime as the subtitle. Notes are
    // matched by trigram.
    return this.prisma.db.$queryRawUnsafe<SearchHit[]>(
      `
      SELECT a.id,
             c.name AS title,
             TO_CHAR(a."startTime" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS subtitle,
             similarity(immutable_unaccent(lower(coalesce(a.notes, ''))), immutable_unaccent(lower($1)))::float AS score
      FROM "Appointment" a
      JOIN "Customer" c ON c.id = a."customerId"
      WHERE a."deletedAt" IS NULL
        AND (
             immutable_unaccent(lower(coalesce(a.notes, ''))) % immutable_unaccent(lower($1))
          OR a.id::text LIKE $1 || '%'
        )
      ORDER BY score DESC
      LIMIT $2
      `,
      q,
      limit,
    );
  }

  private async searchConversations(
    q: string,
    limit: number,
  ): Promise<SearchHit[]> {
    // Two-signal match:
    //   • summary_tsv @@ websearch_to_tsquery — phrase/boolean search
    //   • Message.content_tsv for in-depth transcript search
    // Union so a hit on either surfaces the conversation once.
    return this.prisma.db.$queryRawUnsafe<SearchHit[]>(
      `
      WITH q AS (
        SELECT websearch_to_tsquery('spanish', immutable_unaccent($1)) AS tsq
      )
      SELECT c.id,
             COALESCE(c.summary, 'Conversation ' || substring(c.id from 1 for 8)) AS title,
             TO_CHAR(c."startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS subtitle,
             GREATEST(
               COALESCE(ts_rank_cd(c."summary_tsv", (SELECT tsq FROM q), 32), 0),
               COALESCE(msg_rank, 0)
             )::float AS score
      FROM "Conversation" c
      LEFT JOIN LATERAL (
        SELECT MAX(ts_rank_cd(m."content_tsv", (SELECT tsq FROM q), 32))::float AS msg_rank
        FROM "Message" m
        WHERE m."conversationId" = c.id
          AND m."content_tsv" @@ (SELECT tsq FROM q)
        LIMIT 1
      ) msg ON TRUE
      WHERE (SELECT tsq FROM q) IS NOT NULL
        AND (c."summary_tsv" @@ (SELECT tsq FROM q) OR msg_rank IS NOT NULL)
      ORDER BY score DESC
      LIMIT $2
      `,
      q,
      limit,
    );
  }
}
