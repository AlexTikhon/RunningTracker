-- The creation instant of an activity comes from the database clock (ADR-0074). It identifies the erased version of
-- a record in the erasure ledger (ADR-0073); until now the service wrote it from the application's injected clock, so
-- a frozen or repeating application clock could give a re-created id the creation instant of an erased version.
--
-- clock_timestamp(), not now(): now() is the transaction start, so a delete and a re-create of one id inside one
-- transaction (possible in direct SQL) would get equal instants. The service no longer sends created_at.
--
-- Deliberately unchanged: the runtime role keeps its table-level INSERT privilege (ADR-0072's grants and access tests
-- are unchanged), so direct SQL as the owner can still state created_at for their own row. That only affects the
-- owner's own erasure identity; the API never does it.
ALTER TABLE activities ALTER COLUMN created_at SET DEFAULT clock_timestamp();

COMMENT ON COLUMN activities.created_at IS
  'Database clock (clock_timestamp()) at insert, since migration 0029 (ADR-0074). Identifies the record version in the erasure ledger (ADR-0073).';
