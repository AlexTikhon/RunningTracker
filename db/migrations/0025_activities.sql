-- Manually entered activities, owner-only health data (ADR-0072). Step 1 of the activity/health direction
-- (docs/product-direction.md). Runs and every run table are unchanged.
--
-- The owner is the only reader and writer: every policy requires the current organization, the current identity as
-- the owner and an active membership. Run sharing (run_shares) is never consulted, so a coach or a grantee sees
-- nothing. There is no UPDATE grant or policy (no edit endpoint exists) and nothing for the maintenance role.
--
-- The "not more than 24 hours in the future" rule for started_at is enforced by the service against its injected
-- clock, deliberately not here: a CHECK using now() would be revalidated against a different clock when a dump is
-- restored. Only the static lower bound is a CHECK.
--
-- Deletion is a hard DELETE without a tombstone or journal: a restored backup can resurrect a deleted activity.
-- This must be revisited before real participants record health data (ADR-0072, section 4).
CREATE TABLE activities (
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  type text NOT NULL,
  started_at timestamptz NOT NULL,
  duration_s integer NOT NULL,
  distance_m double precision,
  rpe smallint,
  notes text,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT activities_owner_membership_fk
    FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT activities_type_known CHECK (
    type IN ('run', 'walk', 'ride', 'hike', 'swim', 'strength', 'other')
  ),
  CONSTRAINT activities_started_at_range CHECK (
    isfinite(started_at) AND started_at >= timestamptz '2000-01-01 00:00:00+00'
  ),
  CONSTRAINT activities_duration_range CHECK (duration_s BETWEEN 1 AND 172800),
  -- PostgreSQL orders NaN above every other value, so the upper bound already excludes it (and both infinities fail
  -- one bound); the explicit comparison states the intent.
  CONSTRAINT activities_distance_range CHECK (
    distance_m IS NULL
    OR (distance_m <> 'NaN'::double precision AND distance_m >= 0 AND distance_m <= 1000000)
  ),
  CONSTRAINT activities_rpe_range CHECK (rpe IS NULL OR rpe BETWEEN 1 AND 10),
  CONSTRAINT activities_notes_length CHECK (
    notes IS NULL OR char_length(notes) BETWEEN 1 AND 1000
  ),
  -- Import sources (gpx, tcx, fit) are added later by a migration that widens this list.
  CONSTRAINT activities_source_known CHECK (source IN ('manual')),
  CONSTRAINT activities_created_at_finite CHECK (isfinite(created_at))
);

CREATE INDEX activities_owner_started_idx
  ON activities (org_id, user_id, started_at DESC, id DESC);

COMMENT ON TABLE activities IS
  'Owner-only manual activities (ADR-0072). No coach or grantee access, no UPDATE, hard delete without tombstone: a restored backup can resurrect deleted rows. type = run overlaps with the runs table; there is no dual-write or link in step 1.';

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY activities_select_owner
ON activities
FOR SELECT
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY activities_insert_owner
ON activities
FOR INSERT
TO running_tracker_runtime
WITH CHECK (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY activities_delete_owner
ON activities
FOR DELETE
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

REVOKE ALL ON TABLE activities FROM PUBLIC;
REVOKE ALL ON TABLE activities FROM running_tracker_runtime;
REVOKE ALL ON TABLE activities FROM running_tracker_maintenance;
GRANT SELECT, INSERT, DELETE ON TABLE activities TO running_tracker_runtime;
