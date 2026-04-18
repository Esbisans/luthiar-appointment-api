-- Composite indexes for keyset (cursor) pagination.
--
-- The `(businessId, <sortField> DESC, id DESC)` shape is what the query
-- planner needs to pick an Index Scan (not Bitmap Heap Scan) when we run
--
--   WHERE "businessId" = ?
--     AND (<sortField> < ?t  OR  (<sortField> = ?t AND id < ?i))
--   ORDER BY <sortField> DESC, id DESC
--   LIMIT N
--
-- Without the trailing `id DESC` the planner can't use the index to do
-- the tiebreak — it degrades to sort-in-memory.

-- Customer: sort by createdAt (most-recently-added first).
CREATE INDEX IF NOT EXISTS "Customer_businessId_createdAt_id_idx"
  ON "Customer" ("businessId", "createdAt" DESC, "id" DESC);

-- Appointment: sort by startTime (dashboard calendar newest-first).
-- Soft-deleted rows filtered via baseWhere; include them in the index
-- covers the common "deletedAt IS NULL" predicate too.
CREATE INDEX IF NOT EXISTS "Appointment_businessId_startTime_id_idx"
  ON "Appointment" ("businessId", "startTime" DESC, "id" DESC);
