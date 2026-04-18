-- Service.slotIntervalMin: grid granularity in minutes for bookings.
--
-- Pattern follows Cal.com / Calendly / Acuity where slot interval lives
-- on the service/event-type, not the business. Defaults to 15 minutes —
-- the industry-standard fallback per 2025 research. Bookings must start
-- at `businessWindowStart + k * slotIntervalMin` (k >= 0).
--
-- Kept as a simple INT column (not a constrained enum) so tenants can
-- pick unusual values later (7 for dev testing, 20 for SMB with odd
-- durations). Application layer can reject invalid values if needed.

ALTER TABLE "Service"
  ADD COLUMN IF NOT EXISTS "slotIntervalMin" INTEGER NOT NULL DEFAULT 15;
