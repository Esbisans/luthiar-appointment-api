-- Allow multiple BusinessHour intervals per (businessId, dayOfWeek).
-- Typical use case: clinics/restaurants that close for lunch
--   Monday  09:00-14:00
--   Monday  16:00-20:00
--
-- Prisma emitted a composite unique constraint for the old shape; we drop
-- it and leave a plain index so look-ups by (businessId, dayOfWeek) stay
-- fast. Uniqueness of (dayOfWeek, startTime) is enforced by the service
-- when the owner replaces the schedule via PUT /business-hours.

ALTER TABLE "BusinessHour" DROP CONSTRAINT IF EXISTS "BusinessHour_businessId_dayOfWeek_key";

CREATE INDEX IF NOT EXISTS "BusinessHour_businessId_dayOfWeek_idx"
  ON "BusinessHour" ("businessId", "dayOfWeek");
