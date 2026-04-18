-- pg_trgm + GIN indexes on Customer for fast search.
--
-- Indexes accelerate BOTH Prisma's ILIKE (via `contains` with
-- mode: 'insensitive') and, later, PostgreSQL's `similarity()` fuzzy
-- search should we need it. pg_trgm index scans are several orders of
-- magnitude faster than sequential scans once the table exceeds a few
-- thousand rows.
--
-- We index `name` (case-insensitive — the index uses lower()) and `phone`
-- (E.164 string — no case folding needed, but trigram still helps with
-- partial matches like "5512").
--
-- Reference: https://www.postgresql.org/docs/current/pgtrgm.html

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Case-insensitive trigram index on name — matches "Ana" to "Ana García"
-- and "ana" alike.
CREATE INDEX IF NOT EXISTS customer_name_trgm_idx
  ON "Customer" USING gin (lower(name) gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

-- Trigram index on phone — speeds up partial matches on E.164 strings.
CREATE INDEX IF NOT EXISTS customer_phone_trgm_idx
  ON "Customer" USING gin (phone gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

-- Email is queried by exact match elsewhere; btree is enough.
-- No index added here.
