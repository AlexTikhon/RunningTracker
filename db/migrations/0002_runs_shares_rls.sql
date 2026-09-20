CREATE TABLE runs (
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'recording',
  started_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  data_revision bigint NOT NULL DEFAULT 0,
  control_revision bigint NOT NULL DEFAULT 0,
  raw_state text NOT NULL DEFAULT 'available',
  PRIMARY KEY (org_id, id),
  CONSTRAINT runs_owner_membership_fk
    FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT runs_status_known CHECK (status IN ('recording', 'paused', 'finished')),
  CONSTRAINT runs_raw_state_known CHECK (raw_state IN ('available', 'purging', 'purged')),
  CONSTRAINT runs_data_revision_nonnegative CHECK (data_revision >= 0),
  CONSTRAINT runs_control_revision_nonnegative CHECK (control_revision >= 0),
  CONSTRAINT runs_finished_state_consistent CHECK (
    (
      status = 'finished'
      AND finished_at IS NOT NULL
      AND finished_at >= started_at
      AND finished_at >= created_at
    )
    OR (status <> 'finished' AND finished_at IS NULL)
  ),
  CONSTRAINT runs_raw_state_requires_finished CHECK (
    raw_state NOT IN ('purging', 'purged') OR status = 'finished'
  )
);

CREATE INDEX runs_owner_started_idx
  ON runs (org_id, user_id, started_at DESC, id DESC);

CREATE UNIQUE INDEX runs_one_active_per_user_idx
  ON runs (user_id)
  WHERE status IN ('recording', 'paused');

CREATE INDEX runs_finished_at_idx
  ON runs (finished_at)
  WHERE status = 'finished';

CREATE TABLE run_shares (
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  grantee_user_id uuid NOT NULL,
  can_read_history boolean NOT NULL DEFAULT false,
  can_read_live boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, run_id, grantee_user_id),
  CONSTRAINT run_shares_run_fk
    FOREIGN KEY (org_id, run_id) REFERENCES runs (org_id, id) ON DELETE CASCADE,
  CONSTRAINT run_shares_grantee_membership_fk
    FOREIGN KEY (org_id, grantee_user_id)
    REFERENCES memberships (org_id, user_id) ON DELETE RESTRICT
);

CREATE FUNCTION app_private.is_run_owner(target_org_id uuid, target_run_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT app_private.has_active_membership()
    AND target_org_id = app_private.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.runs AS target_run
      WHERE target_run.org_id = target_org_id
        AND target_run.id = target_run_id
        AND target_run.user_id = app_private.current_user_id()
    )
$$;

CREATE FUNCTION app_private.can_read_run(target_org_id uuid, target_run_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT app_private.has_active_membership()
    AND target_org_id = app_private.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.runs AS target_run
      WHERE target_run.org_id = target_org_id
        AND target_run.id = target_run_id
        AND (
          target_run.user_id = app_private.current_user_id()
          OR EXISTS (
            SELECT 1
            FROM public.run_shares AS share
            WHERE share.org_id = target_run.org_id
              AND share.run_id = target_run.id
              AND share.grantee_user_id = app_private.current_user_id()
              AND (
                (target_run.status IN ('recording', 'paused') AND share.can_read_live)
                OR (target_run.status = 'finished' AND share.can_read_history)
              )
          )
        )
    )
$$;

REVOKE ALL ON FUNCTION app_private.is_run_owner(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.can_read_run(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.is_run_owner(uuid, uuid) TO running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.can_read_run(uuid, uuid) TO running_tracker_runtime;

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY runs_select_authorized
ON runs
FOR SELECT
TO running_tracker_runtime
USING (app_private.can_read_run(org_id, id));

CREATE POLICY runs_insert_owner
ON runs
FOR INSERT
TO running_tracker_runtime
WITH CHECK (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY runs_update_owner
ON runs
FOR UPDATE
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
)
WITH CHECK (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY run_shares_select_owner_or_grantee
ON run_shares
FOR SELECT
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND app_private.has_active_membership()
  AND (
    grantee_user_id = app_private.current_user_id()
    OR app_private.is_run_owner(org_id, run_id)
  )
);

CREATE POLICY run_shares_insert_owner
ON run_shares
FOR INSERT
TO running_tracker_runtime
WITH CHECK (app_private.is_run_owner(org_id, run_id));

CREATE POLICY run_shares_update_owner
ON run_shares
FOR UPDATE
TO running_tracker_runtime
USING (app_private.is_run_owner(org_id, run_id))
WITH CHECK (app_private.is_run_owner(org_id, run_id));

CREATE POLICY run_shares_delete_owner
ON run_shares
FOR DELETE
TO running_tracker_runtime
USING (app_private.is_run_owner(org_id, run_id));

REVOKE ALL ON TABLE runs, run_shares FROM PUBLIC;
REVOKE ALL ON TABLE runs, run_shares FROM running_tracker_runtime;
REVOKE ALL ON TABLE runs, run_shares FROM running_tracker_maintenance;
GRANT SELECT, INSERT ON TABLE runs TO running_tracker_runtime;
GRANT UPDATE (status, finished_at, data_revision, control_revision, raw_state)
  ON TABLE runs TO running_tracker_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE run_shares TO running_tracker_runtime;
