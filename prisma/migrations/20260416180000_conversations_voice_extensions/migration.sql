-- Conversation / Message extensions for voice-agent persistence.
-- Hand-written: a `prisma migrate dev` would also try to drop our manual
-- EXCLUDE constraint and the `app.current_business_id` DEFAULTs (see
-- docs/prisma-quirks.md Q4) so we restrict to additive ALTERs.

-- ── Enums ──────────────────────────────────────────────────────────────
ALTER TYPE "MessageRole" ADD VALUE IF NOT EXISTS 'TOOL';

DO $$ BEGIN
  CREATE TYPE "ConversationEndedReason" AS ENUM (
    'COMPLETED',
    'USER_HANGUP',
    'AGENT_HANGUP',
    'PARTICIPANT_DISCONNECTED',
    'ERROR',
    'TIMEOUT',
    'TRANSFERRED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── Conversation: lifecycle + correlation + rollups ────────────────────
ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "endedReason"         "ConversationEndedReason",
  ADD COLUMN IF NOT EXISTS "livekitRoomName"     TEXT,
  ADD COLUMN IF NOT EXISTS "livekitSessionId"    TEXT,
  ADD COLUMN IF NOT EXISTS "externalCallId"      TEXT,
  ADD COLUMN IF NOT EXISTS "recordingUrl"        TEXT,
  ADD COLUMN IF NOT EXISTS "recordingDurationMs" INTEGER,
  ADD COLUMN IF NOT EXISTS "totalInputTokens"    INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalOutputTokens"   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalCachedTokens"   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sttAudioSeconds"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ttsCharacters"       INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalCostUsd"        DECIMAL(10,6),
  ADD COLUMN IF NOT EXISTS "messageCount"        INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "hasError"            BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "errorReason"         TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt"           TIMESTAMP(3);

-- updatedAt is required by Prisma but we just added it as nullable.
-- Backfill + enforce NOT NULL with a default so existing rows are valid.
UPDATE "Conversation" SET "updatedAt" = COALESCE("updatedAt", "createdAt", now()) WHERE "updatedAt" IS NULL;
ALTER TABLE "Conversation"
  ALTER COLUMN "updatedAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_livekitRoomName_key"
  ON "Conversation"("livekitRoomName") WHERE "livekitRoomName" IS NOT NULL;

-- Drop legacy single-column indexes superseded by composite ones.
DROP INDEX IF EXISTS "Conversation_businessId_idx";

CREATE INDEX IF NOT EXISTS "Conversation_businessId_startedAt_idx"
  ON "Conversation"("businessId", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "Conversation_businessId_channel_startedAt_idx"
  ON "Conversation"("businessId", "channel", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "Conversation_businessId_endedReason_idx"
  ON "Conversation"("businessId", "endedReason");

-- ── Message: ordering + voice fields + OTel-aligned telemetry ─────────
-- Existing rows (test fixtures only — production has none) need synthetic
-- defaults for the NOT NULL columns. We backfill turnIndex from createdAt
-- ordering and clientTimestamp = createdAt.
ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "turnIndex"         INTEGER,
  ADD COLUMN IF NOT EXISTS "clientTimestamp"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "contentRedacted"   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "toolCalls"         JSONB,
  ADD COLUMN IF NOT EXISTS "toolCallId"        TEXT,
  ADD COLUMN IF NOT EXISTS "audioUrl"          TEXT,
  ADD COLUMN IF NOT EXISTS "audioDurationMs"   INTEGER,
  ADD COLUMN IF NOT EXISTS "interrupted"       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "providerName"      TEXT,
  ADD COLUMN IF NOT EXISTS "requestModel"      TEXT,
  ADD COLUMN IF NOT EXISTS "responseModel"     TEXT,
  ADD COLUMN IF NOT EXISTS "inputTokens"       INTEGER,
  ADD COLUMN IF NOT EXISTS "outputTokens"      INTEGER,
  ADD COLUMN IF NOT EXISTS "cachedInputTokens" INTEGER,
  ADD COLUMN IF NOT EXISTS "finishReason"      TEXT,
  ADD COLUMN IF NOT EXISTS "ttftMs"            INTEGER,
  ADD COLUMN IF NOT EXISTS "latencyMs"         INTEGER,
  ADD COLUMN IF NOT EXISTS "costUsd"           DECIMAL(10,6);

-- Backfill: order by createdAt within each conversation, assign 0..n-1.
UPDATE "Message" m
   SET "turnIndex"       = sub.rn - 1,
       "clientTimestamp" = m."createdAt"
  FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY "conversationId" ORDER BY "createdAt") AS rn
      FROM "Message"
  ) sub
 WHERE m.id = sub.id
   AND m."turnIndex" IS NULL;

ALTER TABLE "Message"
  ALTER COLUMN "turnIndex"       SET NOT NULL,
  ALTER COLUMN "clientTimestamp" SET NOT NULL;

-- Convert content TEXT (was VARCHAR by default in Prisma).
ALTER TABLE "Message" ALTER COLUMN "content" TYPE TEXT;

-- Idempotency safety net: same (conversationId, turnIndex) twice = retry.
CREATE UNIQUE INDEX IF NOT EXISTS "Message_conversationId_turnIndex_key"
  ON "Message"("conversationId", "turnIndex");

-- Drop legacy index superseded by composite ones below.
DROP INDEX IF EXISTS "Message_conversationId_createdAt_idx";

CREATE INDEX IF NOT EXISTS "Message_conversationId_turnIndex_idx"
  ON "Message"("conversationId", "turnIndex");
CREATE INDEX IF NOT EXISTS "Message_businessId_createdAt_idx"
  ON "Message"("businessId", "createdAt" DESC);
