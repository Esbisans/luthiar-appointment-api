-- Global search endpoint (GET /search?q=) indexes.
--
-- Two strategies, one per field kind:
--
--   1. Short fields (names, phones, emails): `pg_trgm` with GIN. Handles
--      typos ("Maria" ≈ "Mariia") and works for sub-2-char tokens better
--      than tsvector would.
--
--   2. Long fields (conversation messages, appointment notes, summaries):
--      stored-generated `tsvector` + GIN. `websearch_to_tsquery` handles
--      quoted phrases, OR, -exclude natively — exactly the UX we want.
--
-- `unaccent` is chained into every generated tsvector AND the query side
-- so "Josefína" ≈ "Josefina" works for es-MX callers.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ── Short-field trigram indexes ───────────────────────────────────
CREATE INDEX IF NOT EXISTS "Staff_name_trgm_idx"
  ON "Staff" USING gin (lower(name) gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Service_name_trgm_idx"
  ON "Service" USING gin (lower(name) gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Service_description_trgm_idx"
  ON "Service" USING gin (lower(coalesce(description, '')) gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Appointment_notes_trgm_idx"
  ON "Appointment" USING gin (lower(coalesce(notes, '')) gin_trgm_ops);

-- Customer indexes already exist (customer_name_trgm_idx,
-- customer_phone_trgm_idx from 20260415015738_customer_trgm_index).
-- Add email for completeness.
CREATE INDEX IF NOT EXISTS "Customer_email_trgm_idx"
  ON "Customer" USING gin (lower(coalesce(email, '')) gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

-- ── Long-field tsvector (stored generated column + GIN) ───────────
-- `unaccent` is IMMUTABLE since PostgreSQL 12+ when called on a literal
-- dictionary reference; using it in a generated column works out of the
-- box. We create a tiny wrapper function `immutable_unaccent` to make
-- the intent explicit.

CREATE OR REPLACE FUNCTION immutable_unaccent(text)
  RETURNS text
  AS $$ SELECT unaccent('unaccent', $1) $$
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

-- Message.content — long transcripts from voice/WA agents.
ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "content_tsv" tsvector
    GENERATED ALWAYS AS (
      to_tsvector('spanish', immutable_unaccent(coalesce(content, '')))
    ) STORED;

CREATE INDEX IF NOT EXISTS "Message_content_tsv_idx"
  ON "Message" USING gin ("content_tsv");

-- Conversation.summary — short LLM rollup at close time.
ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "summary_tsv" tsvector
    GENERATED ALWAYS AS (
      to_tsvector('spanish', immutable_unaccent(coalesce(summary, '')))
    ) STORED;

CREATE INDEX IF NOT EXISTS "Conversation_summary_tsv_idx"
  ON "Conversation" USING gin ("summary_tsv");
