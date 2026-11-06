-- Weekly insights, owner-only derived health data (ADR-0076). One row per person per week: the week's numbers are
-- computed by the service from the person's check-ins, activities and GPS runs, and a local language model writes text
-- about them. The row keeps the text (when it passed the service's grounding and safety checks), never the numbers or
-- the prompt, and never free-text notes, which are not part of the model input at all.
--
-- Access: the owner-only template of activities (ADR-0072) and daily_metrics (ADR-0074), for all four operations.
-- Every policy requires the current organization, the current identity as the owner and an active membership; run
-- sharing is never consulted, so a coach or a grantee sees nothing, and the maintenance role has no privilege at all.
--   - INSERT is granted on the columns the service supplies; `id`, `status` ('pending'), `output` (NULL) and
--     `created_at` (clock_timestamp()) always take their defaults.
--   - UPDATE is granted on `status` and `output` only: the background generation writes its result, and a request
--     resets a `generation_failed` row to `pending`. The week, the input hash, the model and the prompt version of a row
--     never change; a different input replaces the row (DELETE, then INSERT).
--
-- `range_start`/`range_end` are the instants at which the week's Monday and the following Monday begin in `time_zone`,
-- computed by the service with the platform's zone database. They are stored so that the erasure triggers of
-- migration 0031 compare instants only: a zone name PostgreSQL does not know can never make a deletion fail.
--
-- Erasure: deleting a source record deletes the insights of its week in the same statement (migration 0031). Rows
-- themselves are not journaled: they are derived, and a restore replay of the source erasures removes them again.
CREATE TABLE weekly_insights (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  week_start date NOT NULL,
  time_zone text NOT NULL,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  input_hash text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT weekly_insights_one_per_week UNIQUE (org_id, user_id, week_start),
  CONSTRAINT weekly_insights_owner_membership_fk
    FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT weekly_insights_week_start_monday CHECK (
    isfinite(week_start) AND week_start >= date '2000-01-01' AND extract(isodow FROM week_start) = 1
  ),
  CONSTRAINT weekly_insights_time_zone_shape CHECK (
    char_length(time_zone) BETWEEN 1 AND 64 AND time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'
  ),
  -- A week is 7 local days: between 6 and 8 days of instants covers every daylight-saving and zone-change week.
  CONSTRAINT weekly_insights_range_valid CHECK (
    isfinite(range_start) AND isfinite(range_end)
    AND range_end > range_start
    AND range_end - range_start BETWEEN interval '6 days' AND interval '8 days'
  ),
  CONSTRAINT weekly_insights_input_hash_shape CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT weekly_insights_model_length CHECK (char_length(model) BETWEEN 1 AND 64),
  CONSTRAINT weekly_insights_prompt_version_length CHECK (char_length(prompt_version) BETWEEN 1 AND 64),
  CONSTRAINT weekly_insights_status_known CHECK (
    status IN ('pending', 'ready', 'generation_failed', 'failed_grounding', 'failed_safety')
  ),
  -- Output exists exactly for a ready insight: a failed check discards the model's answer, it is never kept.
  CONSTRAINT weekly_insights_output_only_when_ready CHECK ((status = 'ready') = (output IS NOT NULL)),
  CONSTRAINT weekly_insights_output_shape CHECK (
    output IS NULL OR (jsonb_typeof(output) = 'object' AND octet_length(output::text) <= 16384)
  ),
  CONSTRAINT weekly_insights_created_at_finite CHECK (isfinite(created_at))
);

COMMENT ON TABLE weekly_insights IS
  'Owner-only weekly insights (ADR-0076): text a local language model wrote about numbers the service computed, kept only after grounding and safety checks. One row per person, organization and week. No coach or grantee access. Deleted with the week of any deleted source record (migration 0031).';
COMMENT ON COLUMN weekly_insights.input_hash IS
  'SHA-256 of the canonical JSON of the computed weekly aggregate (the model input data). Same hash, model and prompt version = same insight.';

ALTER TABLE weekly_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY weekly_insights_select_owner
ON weekly_insights
FOR SELECT
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY weekly_insights_insert_owner
ON weekly_insights
FOR INSERT
TO running_tracker_runtime
WITH CHECK (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY weekly_insights_update_owner
ON weekly_insights
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

CREATE POLICY weekly_insights_delete_owner
ON weekly_insights
FOR DELETE
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

REVOKE ALL ON TABLE weekly_insights FROM PUBLIC;
REVOKE ALL ON TABLE weekly_insights FROM running_tracker_runtime;
REVOKE ALL ON TABLE weekly_insights FROM running_tracker_maintenance;
GRANT SELECT, DELETE ON TABLE weekly_insights TO running_tracker_runtime;
GRANT INSERT (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, model, prompt_version)
  ON TABLE weekly_insights TO running_tracker_runtime;
GRANT UPDATE (status, output) ON TABLE weekly_insights TO running_tracker_runtime;
