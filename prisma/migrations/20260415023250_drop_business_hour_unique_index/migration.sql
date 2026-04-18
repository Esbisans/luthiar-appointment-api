-- Follow-up to 20260415022204_business_hours_multi_window.
-- Prisma's @@unique leaves a UNIQUE INDEX behind even after the constraint
-- is dropped. We remove the index explicitly so multiple rows per
-- (businessId, dayOfWeek) can be persisted.

DROP INDEX IF EXISTS "BusinessHour_businessId_dayOfWeek_key";
