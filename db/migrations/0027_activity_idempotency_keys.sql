-- Idempotent activity creation across edits (ADR-0073, part B). The activity id already makes one exact payload
-- idempotent; it does not help when a save's outcome is unknown and the person edits the form and saves again under a
-- new id. The web client now sends one idempotency key per form session. The key is unique per owner in an
-- organization, so a second save from the same form session can never create a second activity: the service answers
-- with the saved activity (same details) or 409 ACTIVITY_ALREADY_SAVED (different details).
--
-- Nullable at the database level so rows inserted before this migration, and by direct SQL, stay valid; the HTTP
-- contract requires a key on every create. Unique constraints treat NULLs as distinct, so unkeyed rows never collide.
-- The column is covered by the runtime role's existing table-level SELECT and INSERT grants; RLS is unchanged.
ALTER TABLE activities ADD COLUMN idempotency_key uuid;

ALTER TABLE activities
  ADD CONSTRAINT activities_owner_idempotency_key_unique UNIQUE (org_id, user_id, idempotency_key);

COMMENT ON COLUMN activities.idempotency_key IS
  'Client-generated key of the form session that created the activity (ADR-0073). Unique per owner and organization. A deleted activity frees its key.';
