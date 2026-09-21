CREATE TABLE run_commands (
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  command_id uuid NOT NULL,
  canonical_payload jsonb NOT NULL,
  response jsonb NOT NULL,
  received_at timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (org_id, run_id, command_id),
  CONSTRAINT run_commands_run_fk
    FOREIGN KEY (org_id, run_id) REFERENCES runs (org_id, id) ON DELETE CASCADE,
  CONSTRAINT run_commands_canonical_payload_object CHECK (
    jsonb_typeof(canonical_payload) = 'object'
  ),
  CONSTRAINT run_commands_response_object CHECK (
    jsonb_typeof(response) = 'object'
  ),
  CONSTRAINT run_commands_received_at_finite CHECK (isfinite(received_at))
);

COMMENT ON COLUMN run_commands.canonical_payload IS
  'A JSON object retained for future P03 command replay. JSONB storage and this name do not by themselves define canonicalization, semantic duplicate comparison, command validation, or transaction atomicity with a run update.';

COMMENT ON COLUMN run_commands.response IS
  'A JSON object retained for future P03 replay. Its complete HTTP response contract is not defined by this schema fragment.';

CREATE TABLE run_tombstones (
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  deleted_at timestamp(3) with time zone NOT NULL,
  expires_at timestamp(3) with time zone NOT NULL,
  PRIMARY KEY (org_id, run_id),
  CONSTRAINT run_tombstones_owner_membership_fk
    FOREIGN KEY (org_id, owner_user_id)
    REFERENCES memberships (org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT run_tombstones_deleted_at_finite CHECK (isfinite(deleted_at)),
  CONSTRAINT run_tombstones_expires_at_finite CHECK (isfinite(expires_at)),
  CONSTRAINT run_tombstones_expiry_after_deletion CHECK (expires_at > deleted_at)
);

CREATE INDEX run_tombstones_expires_at_idx
  ON run_tombstones (expires_at);

COMMENT ON TABLE run_tombstones IS
  'Deletion markers without run payload or coordinates. P10 defines retention, expiry behavior, cleanup, and the atomic tombstone/run/archive-revision deletion transaction; this table has no foreign key to runs.';

ALTER TABLE run_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_tombstones ENABLE ROW LEVEL SECURITY;

CREATE POLICY run_commands_select_owner
ON run_commands
FOR SELECT
TO running_tracker_runtime
USING (app_private.is_run_owner(org_id, run_id));

CREATE POLICY run_commands_insert_owner
ON run_commands
FOR INSERT
TO running_tracker_runtime
WITH CHECK (app_private.is_run_owner(org_id, run_id));

CREATE POLICY run_tombstones_select_owner
ON run_tombstones
FOR SELECT
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND owner_user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

REVOKE ALL ON TABLE run_commands, run_tombstones FROM PUBLIC;
REVOKE ALL ON TABLE run_commands, run_tombstones FROM running_tracker_runtime;
REVOKE ALL ON TABLE run_commands, run_tombstones FROM running_tracker_maintenance;
GRANT SELECT, INSERT ON TABLE run_commands TO running_tracker_runtime;
GRANT SELECT ON TABLE run_tombstones TO running_tracker_runtime;
