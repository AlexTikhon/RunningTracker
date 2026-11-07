-- Weekly insights: source synchronization, finite job states and policy versions (ADR-0076).
--
-- Why: migrations 0030/0031 deleted a week's insights when a source record was deleted, but nothing ordered that
-- deletion against a generation request that had already READ the sources and had not yet INSERTED its row. A probe
-- reproduced it: the request read a check-in (sleep 450 min), the check-in was deleted and committed while no insight
-- row existed (the trigger deleted nothing), then the request inserted its row and the model published "average sleep
-- was 450 minutes". A transaction, REPEATABLE READ or an unlocked hash recheck does not close that window: the
-- deletion and the insertion touch different rows, so neither waits for the other.
--
-- The protocol (one gate row per person and organization):
--   * weekly_insight_source_gates(org_id, user_id, revision). Every change of an insight source advances the person's
--     revision (INSERT ... ON CONFLICT DO UPDATE: a row lock held until the changing transaction ends), and does so
--     BEFORE it deletes any insight, in AFTER ... FOR EACH STATEMENT triggers. They fire for every path that can change
--     a source: the API, an owner's permitted SQL under RLS, maintenance (retention, summary publication), the restore
--     replays and the object owner's SQL. TRUNCATE is not covered (no role but the object owner holds it).
--   * A generation request locks its own gate row FIRST (app_private.lock_weekly_insight_sources('exclusive')), then
--     reads every source in one statement, then inserts its row with the revision it locked. READ COMMITTED: each
--     statement after the lock sees everything committed before the lock was granted.
--   * A BEFORE INSERT trigger on weekly_insights takes the gate FOR SHARE and refuses (SQLSTATE 40001) a row whose
--     source_revision is not the current revision, so no insert path, direct SQL included, can store an insight about
--     sources that changed after it read them.
--
-- Why that closes the interleavings (G = generation, M = a source deletion or relevant update):
--   1. G locks the gate before M advances it: M's advance waits for G's COMMIT. G read the sources as they were before
--      M (M had not committed), inserted its row and committed; M then continues, and its insight DELETE is a new
--      statement with a new snapshot (VOLATILE plpgsql, READ COMMITTED), so it sees and deletes G's row.
--   2. M advances first: G's lock waits for M's COMMIT; G's source read is a later statement, so it sees M's change.
--   3. A writer that skips step 1 (direct SQL): its insert takes the gate FOR SHARE; if M advanced after the writer's
--      reads, the revision differs and the insert fails; if M has not advanced yet, M waits for the writer and then
--      deletes its row as in 1.
--   Under REPEATABLE READ or SERIALIZABLE, a writer whose snapshot predates a concurrent advance gets a serialization
--   failure on the gate instead of waiting: the outcome is a rollback, never a stale commit.
--
-- Lock order: source rows (taken by the changing statement) -> gate rows (in (org_id, user_id) order within one
-- statement) -> weekly_insights rows. A generation request takes gate -> weekly_insights and never locks a source row.
-- Result publication takes gate (FOR SHARE) -> its own weekly_insights row. Two transactions that change sources of
-- two people in opposite orders can deadlock on the gates; PostgreSQL detects it and rolls one back.
--
-- No database connection is held during model inference: the request commits before the model is called, and the
-- result is written in a separate short transaction that matches the row's job token (see weekly_insights below).
--
-- Restore replays: deleting an erased record that IS in the restored data fires the triggers above (week-precise).
-- A ledger or journal entry carries no date of the record, so when the record is ALREADY ABSENT (or a different record
-- holds its id) its week is unknown. The replay wrappers below therefore invalidate, conservatively and for every
-- outcome (so a second replay finds nothing more to delete): an erasure-ledger entry, the person's insights created
-- at or after the record's creation instant (an older insight cannot have read it); a run-journal entry, which has
-- no creation instant, all of the person's insights in the organization. Derived data only. The ledger and journal
-- file formats, the replay outcomes and the record-version protection are unchanged: the original functions are
-- kept, renamed, and called first.

-- 1. The source gate. No privilege for any application role: reached only through the SECURITY DEFINER functions.
CREATE TABLE weekly_insight_source_gates (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, user_id),
  CONSTRAINT weekly_insight_source_gates_revision_nonnegative CHECK (revision >= 0)
);

COMMENT ON TABLE weekly_insight_source_gates IS
  'Per person and organization revision of the weekly insight sources (ADR-0076). Advanced, under a row lock, by every change of an activity, check-in day, run or run summary before any insight is deleted; locked first by a generation request. Identifiers and a counter only; no foreign key, so no source change can fail on it.';

ALTER TABLE weekly_insight_source_gates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE weekly_insight_source_gates FROM PUBLIC;
REVOKE ALL ON TABLE weekly_insight_source_gates FROM running_tracker_runtime;
REVOKE ALL ON TABLE weekly_insight_source_gates FROM running_tracker_maintenance;

CREATE FUNCTION app_private.advance_weekly_insight_source(target_org_id uuid, target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.weekly_insight_source_gates AS gate (org_id, user_id, revision)
  VALUES (target_org_id, target_user_id, 1)
  ON CONFLICT (org_id, user_id) DO UPDATE SET revision = gate.revision + 1;
END;
$$;

CREATE FUNCTION app_private.invalidate_weekly_insights_for_owner(target_org_id uuid, target_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  removed integer;
BEGIN
  PERFORM app_private.advance_weekly_insight_source(target_org_id, target_user_id);
  DELETE FROM public.weekly_insights AS insight
  WHERE insight.org_id = target_org_id AND insight.user_id = target_user_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

-- The runtime role's only way to the gate: its own row, in the organization of the transaction, as an active member.
-- 'exclusive' (FOR UPDATE) for a generation request, 'shared' (FOR SHARE) for result publication. Returns the revision.
CREATE FUNCTION app_private.lock_weekly_insight_sources(lock_mode text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_org_id uuid := app_private.current_org_id();
  target_user_id uuid := app_private.current_user_id();
  locked_revision bigint;
BEGIN
  IF target_org_id IS NULL OR target_user_id IS NULL OR NOT app_private.has_active_membership() THEN
    RAISE EXCEPTION 'weekly insight sources can only be locked by an active member for themselves'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.weekly_insight_source_gates (org_id, user_id)
  VALUES (target_org_id, target_user_id)
  ON CONFLICT (org_id, user_id) DO NOTHING;
  IF lock_mode = 'exclusive' THEN
    SELECT gate.revision INTO locked_revision
    FROM public.weekly_insight_source_gates AS gate
    WHERE gate.org_id = target_org_id AND gate.user_id = target_user_id
    FOR UPDATE;
  ELSIF lock_mode = 'shared' THEN
    SELECT gate.revision INTO locked_revision
    FROM public.weekly_insight_source_gates AS gate
    WHERE gate.org_id = target_org_id AND gate.user_id = target_user_id
    FOR SHARE;
  ELSE
    RAISE EXCEPTION 'unknown weekly insight source lock mode: %', lock_mode USING ERRCODE = '22023';
  END IF;
  RETURN locked_revision;
END;
$$;

REVOKE ALL ON FUNCTION app_private.advance_weekly_insight_source(uuid, uuid)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.invalidate_weekly_insights_for_owner(uuid, uuid)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.lock_weekly_insight_sources(text)
  FROM PUBLIC, running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.lock_weekly_insight_sources(text) TO running_tracker_runtime;

-- 2. weekly_insights: source revision, policy version and finite job states.
--   queued      accepted, waiting for this process's generation queue (job_token + lease)
--   running     the model is being asked (job_token + lease)
--   ready       output passed schema, claim grounding and safety checks
--   generation_failed / failed_grounding / failed_safety   terminal for this input (failure_reason is a code)
--   interrupted the job ended without a result: shutdown, persistence failure, or (derived at read time) an expired
--               lease after a process restart. A new request for the same input may retry, a bounded number of times.
-- Rows written before this migration are kept but never trusted: policy_version 'weekly-insight-policy-1' differs from
-- every current policy, so the API withholds their output and a request regenerates them. Their 'pending' becomes
-- 'interrupted' (no process holds them any more).
ALTER TABLE weekly_insights DROP CONSTRAINT weekly_insights_status_known;
ALTER TABLE weekly_insights DROP CONSTRAINT weekly_insights_output_only_when_ready;
UPDATE weekly_insights SET status = 'interrupted' WHERE status = 'pending';

ALTER TABLE weekly_insights
  ADD COLUMN source_revision bigint,
  ADD COLUMN policy_version text NOT NULL DEFAULT 'weekly-insight-policy-1',
  ADD COLUMN failure_reason text,
  ADD COLUMN job_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz;

UPDATE weekly_insights SET source_revision = 0, updated_at = created_at;

ALTER TABLE weekly_insights
  ALTER COLUMN source_revision SET NOT NULL,
  ALTER COLUMN policy_version DROP DEFAULT,
  ALTER COLUMN status SET DEFAULT 'queued',
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT clock_timestamp(),
  ADD CONSTRAINT weekly_insights_status_known CHECK (
    status IN ('queued', 'running', 'ready', 'generation_failed', 'failed_grounding', 'failed_safety', 'interrupted')
  ),
  ADD CONSTRAINT weekly_insights_output_only_when_ready CHECK ((status = 'ready') = (output IS NOT NULL)),
  -- A job exists exactly while the row is queued or running; its token fences late results.
  ADD CONSTRAINT weekly_insights_job_only_when_active CHECK (
    (status IN ('queued', 'running')) = (job_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT weekly_insights_lease_finite CHECK (lease_expires_at IS NULL OR isfinite(lease_expires_at)),
  ADD CONSTRAINT weekly_insights_failure_reason_shape CHECK (
    failure_reason IS NULL
    OR (status IN ('generation_failed', 'failed_grounding', 'failed_safety', 'interrupted')
        AND failure_reason ~ '^[a-z][a-z_]{0,47}$')
  ),
  ADD CONSTRAINT weekly_insights_attempts_range CHECK (attempts BETWEEN 1 AND 100),
  ADD CONSTRAINT weekly_insights_source_revision_nonnegative CHECK (source_revision >= 0),
  ADD CONSTRAINT weekly_insights_policy_version_length CHECK (char_length(policy_version) BETWEEN 1 AND 64),
  ADD CONSTRAINT weekly_insights_updated_at_finite CHECK (isfinite(updated_at));

COMMENT ON TABLE weekly_insights IS
  'Owner-only weekly insights (ADR-0076): model prose and code-checked fact claims about numbers the service computed, kept only after schema, grounding and safety checks. One row per person, organization and week, with a finite job state. Inserted only for the current source revision (weekly_insight_source_gates); deleted with the week of any deleted or changed source record, and all of a person''s rows when a restore replay finds an erased record already absent. No coach or grantee access.';
COMMENT ON COLUMN weekly_insights.source_revision IS
  'The gate revision the generation request locked before it read the sources. Enforced equal to the current revision at INSERT.';
COMMENT ON COLUMN weekly_insights.policy_version IS
  'Aggregation, fact, grounding and safety policy the row was validated under. A row of another policy is never shown as current.';

CREATE FUNCTION app_private.check_weekly_insight_source_revision()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  current_revision bigint;
BEGIN
  -- An application session (app.user_id set) inserting a row for someone else: row-level security refuses it right
  -- after this trigger. Return without touching that person's gate, so the error cannot reveal their revision.
  IF app_private.current_user_id() IS NOT NULL
    AND (NEW.user_id IS DISTINCT FROM app_private.current_user_id() OR NEW.org_id IS DISTINCT FROM app_private.current_org_id())
  THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.weekly_insight_source_gates (org_id, user_id)
  VALUES (NEW.org_id, NEW.user_id)
  ON CONFLICT (org_id, user_id) DO NOTHING;
  SELECT gate.revision INTO current_revision
  FROM public.weekly_insight_source_gates AS gate
  WHERE gate.org_id = NEW.org_id AND gate.user_id = NEW.user_id
  FOR SHARE;
  IF current_revision IS DISTINCT FROM NEW.source_revision THEN
    RAISE EXCEPTION 'weekly insight sources changed after they were read (revision % is not %)',
      NEW.source_revision, current_revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app_private.touch_weekly_insights_updated_at()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.check_weekly_insight_source_revision()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.touch_weekly_insights_updated_at()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER weekly_insights_require_current_sources
BEFORE INSERT ON weekly_insights
FOR EACH ROW
EXECUTE FUNCTION app_private.check_weekly_insight_source_revision();

CREATE TRIGGER weekly_insights_touch_updated_at
BEFORE UPDATE ON weekly_insights
FOR EACH ROW
EXECUTE FUNCTION app_private.touch_weekly_insights_updated_at();

REVOKE INSERT, UPDATE ON TABLE weekly_insights FROM running_tracker_runtime;
GRANT INSERT (
  org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, source_revision, model, prompt_version,
  policy_version, job_token, lease_expires_at
) ON TABLE weekly_insights TO running_tracker_runtime;
GRANT UPDATE (status, output, failure_reason, job_token, lease_expires_at, attempts)
  ON TABLE weekly_insights TO running_tracker_runtime;

-- 3. Source triggers. The row-level erasure triggers of migration 0031 are replaced by statement-level ones that
-- advance the gates of every affected person (sorted) before deleting insights.
DROP TRIGGER activities_erase_weekly_insights ON activities;
DROP TRIGGER daily_metrics_erase_weekly_insights ON daily_metrics;
DROP TRIGGER daily_metrics_change_erases_weekly_insights ON daily_metrics;
DROP TRIGGER runs_erase_weekly_insights ON runs;
DROP FUNCTION app_private.erase_weekly_insights_for_activity();
DROP FUNCTION app_private.erase_weekly_insights_for_daily_metric();
DROP FUNCTION app_private.erase_weekly_insights_for_run();

-- Inserts (activities, check-in days, runs): advance only. A new record never makes an insight wrong, only stale; the
-- API reports staleness by recomputing the input (ADR-0076), and the gate keeps a generation's reads coherent.
CREATE FUNCTION app_private.weekly_insight_sources_inserted()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  affected record;
BEGIN
  FOR affected IN
    SELECT DISTINCT changed.org_id, changed.user_id FROM inserted_rows AS changed ORDER BY 1, 2
  LOOP
    PERFORM app_private.advance_weekly_insight_source(affected.org_id, affected.user_id);
  END LOOP;
  RETURN NULL;
END;
$$;

-- Deletions of records placed by their start instant (activities, runs): advance, then delete the insights whose stored
-- [range_start, range_end) contains a deleted record.
CREATE FUNCTION app_private.weekly_insight_sources_deleted_by_instant()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  affected record;
BEGIN
  FOR affected IN
    SELECT DISTINCT gone.org_id, gone.user_id FROM deleted_rows AS gone ORDER BY 1, 2
  LOOP
    PERFORM app_private.advance_weekly_insight_source(affected.org_id, affected.user_id);
  END LOOP;
  DELETE FROM public.weekly_insights AS insight
  USING deleted_rows AS gone
  WHERE insight.org_id = gone.org_id
    AND insight.user_id = gone.user_id
    AND insight.range_start <= gone.started_at
    AND gone.started_at < insight.range_end;
  RETURN NULL;
END;
$$;

CREATE FUNCTION app_private.weekly_insight_daily_metrics_deleted()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  affected record;
BEGIN
  FOR affected IN
    SELECT DISTINCT gone.org_id, gone.user_id FROM deleted_rows AS gone ORDER BY 1, 2
  LOOP
    PERFORM app_private.advance_weekly_insight_source(affected.org_id, affected.user_id);
  END LOOP;
  DELETE FROM public.weekly_insights AS insight
  USING deleted_rows AS gone
  WHERE insight.org_id = gone.org_id
    AND insight.user_id = gone.user_id
    AND insight.week_start <= gone.local_date
    AND gone.local_date < insight.week_start + 7;
  RETURN NULL;
END;
$$;

-- A check-in day whose values, zone or date change: the insight may quote a value that no longer exists. Note-only
-- changes and exact retries change nothing the model sees: no advance, no deletion.
CREATE FUNCTION app_private.weekly_insight_daily_metrics_updated()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  affected record;
BEGIN
  -- No temporary table: a SECURITY DEFINER function must not write to a pg_temp relation the caller could have
  -- created first. The changed-row join is simply evaluated twice.
  FOR affected IN
    SELECT DISTINCT side.org_id, side.user_id
    FROM old_rows AS before_row
    JOIN new_rows AS after_row ON after_row.id = before_row.id
    CROSS JOIN LATERAL (VALUES (before_row.org_id, before_row.user_id), (after_row.org_id, after_row.user_id))
      AS side (org_id, user_id)
    WHERE (before_row.org_id, before_row.user_id, before_row.local_date, before_row.time_zone, before_row.weight_kg,
           before_row.sleep_minutes, before_row.sleep_quality, before_row.mood, before_row.soreness)
          IS DISTINCT FROM
          (after_row.org_id, after_row.user_id, after_row.local_date, after_row.time_zone, after_row.weight_kg,
           after_row.sleep_minutes, after_row.sleep_quality, after_row.mood, after_row.soreness)
    ORDER BY 1, 2
  LOOP
    PERFORM app_private.advance_weekly_insight_source(affected.org_id, affected.user_id);
  END LOOP;
  DELETE FROM public.weekly_insights AS insight
  USING old_rows AS before_row
  JOIN new_rows AS after_row ON after_row.id = before_row.id
  CROSS JOIN LATERAL (
    VALUES (before_row.org_id, before_row.user_id, before_row.local_date),
           (after_row.org_id, after_row.user_id, after_row.local_date)
  ) AS side (org_id, user_id, local_date)
  WHERE (before_row.org_id, before_row.user_id, before_row.local_date, before_row.time_zone, before_row.weight_kg,
         before_row.sleep_minutes, before_row.sleep_quality, before_row.mood, before_row.soreness)
        IS DISTINCT FROM
        (after_row.org_id, after_row.user_id, after_row.local_date, after_row.time_zone, after_row.weight_kg,
         after_row.sleep_minutes, after_row.sleep_quality, after_row.mood, after_row.soreness)
    AND insight.org_id = side.org_id
    AND insight.user_id = side.user_id
    AND insight.week_start <= side.local_date
    AND side.local_date < insight.week_start + 7;
  RETURN NULL;
END;
$$;

-- Activities have no UPDATE privilege for any application role; an object owner's change is still covered, in both the
-- old and the new week.
CREATE FUNCTION app_private.weekly_insight_activities_updated()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  affected record;
BEGIN
  FOR affected IN
    SELECT DISTINCT side.org_id, side.user_id
    FROM old_rows AS before_row
    JOIN new_rows AS after_row ON after_row.org_id = before_row.org_id AND after_row.id = before_row.id
    CROSS JOIN LATERAL (VALUES (before_row.org_id, before_row.user_id), (after_row.org_id, after_row.user_id))
      AS side (org_id, user_id)
    WHERE (before_row.user_id, before_row.type, before_row.started_at, before_row.duration_s, before_row.distance_m)
          IS DISTINCT FROM
          (after_row.user_id, after_row.type, after_row.started_at, after_row.duration_s, after_row.distance_m)
    ORDER BY 1, 2
  LOOP
    PERFORM app_private.advance_weekly_insight_source(affected.org_id, affected.user_id);
  END LOOP;
  DELETE FROM public.weekly_insights AS insight
  USING old_rows AS before_row
  JOIN new_rows AS after_row ON after_row.org_id = before_row.org_id AND after_row.id = before_row.id
  CROSS JOIN LATERAL (
    VALUES (before_row.org_id, before_row.user_id, before_row.started_at),
           (after_row.org_id, after_row.user_id, after_row.started_at)
  ) AS side (org_id, user_id, started_at)
  WHERE (before_row.user_id, before_row.type, before_row.started_at, before_row.duration_s, before_row.distance_m)
        IS DISTINCT FROM
        (after_row.user_id, after_row.type, after_row.started_at, after_row.duration_s, after_row.distance_m)
    AND insight.org_id = side.org_id
    AND insight.user_id = side.user_id
    AND insight.range_start <= side.started_at
    AND side.started_at < insight.range_end;
  RETURN NULL;
END;
$$;

-- Runs: only finished runs are an insight source. A status, time or data revision change of a run that is or becomes
-- finished (finishing, a late point upload inside the upload window) advances; nothing is deleted, because no value
-- disappears: the API reports the insight as stale instead.
CREATE FUNCTION app_private.weekly_insight_runs_updated()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  affected record;
BEGIN
  FOR affected IN
    SELECT DISTINCT side.org_id, side.user_id
    FROM old_rows AS before_row
    JOIN new_rows AS after_row ON after_row.org_id = before_row.org_id AND after_row.id = before_row.id
    CROSS JOIN LATERAL (VALUES (before_row.org_id, before_row.user_id), (after_row.org_id, after_row.user_id))
      AS side (org_id, user_id)
    WHERE (before_row.status = 'finished' OR after_row.status = 'finished')
      AND (before_row.user_id, before_row.status, before_row.started_at, before_row.finished_at, before_row.data_revision)
          IS DISTINCT FROM
          (after_row.user_id, after_row.status, after_row.started_at, after_row.finished_at, after_row.data_revision)
    ORDER BY 1, 2
  LOOP
    PERFORM app_private.advance_weekly_insight_source(affected.org_id, affected.user_id);
  END LOOP;
  RETURN NULL;
END;
$$;

-- Run summaries (published by maintenance): the GPS distance of a run comes only from a summary whose source_revision
-- equals the run's data_revision, so any summary change advances the run owner's gate. A summary deleted together with
-- its run finds no run row; the run's own deletion trigger advances then.
CREATE FUNCTION app_private.weekly_insight_run_summaries_changed()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  affected record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    FOR affected IN
      SELECT DISTINCT run.org_id, run.user_id
      FROM deleted_rows AS summary
      JOIN public.runs AS run ON run.org_id = summary.org_id AND run.id = summary.run_id
      ORDER BY 1, 2
    LOOP
      PERFORM app_private.advance_weekly_insight_source(affected.org_id, affected.user_id);
    END LOOP;
  ELSE
    FOR affected IN
      SELECT DISTINCT run.org_id, run.user_id
      FROM changed_rows AS summary
      JOIN public.runs AS run ON run.org_id = summary.org_id AND run.id = summary.run_id
      ORDER BY 1, 2
    LOOP
      PERFORM app_private.advance_weekly_insight_source(affected.org_id, affected.user_id);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_private.weekly_insight_sources_inserted()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.weekly_insight_sources_deleted_by_instant()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.weekly_insight_daily_metrics_deleted()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.weekly_insight_daily_metrics_updated()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.weekly_insight_activities_updated()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.weekly_insight_runs_updated()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.weekly_insight_run_summaries_changed()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

-- Transition tables allow one event per trigger.
CREATE TRIGGER activities_weekly_insight_sources_inserted
AFTER INSERT ON activities REFERENCING NEW TABLE AS inserted_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_sources_inserted();
CREATE TRIGGER activities_weekly_insight_sources_updated
AFTER UPDATE ON activities REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_activities_updated();
CREATE TRIGGER activities_weekly_insight_sources_deleted
AFTER DELETE ON activities REFERENCING OLD TABLE AS deleted_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_sources_deleted_by_instant();

CREATE TRIGGER daily_metrics_weekly_insight_sources_inserted
AFTER INSERT ON daily_metrics REFERENCING NEW TABLE AS inserted_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_sources_inserted();
CREATE TRIGGER daily_metrics_weekly_insight_sources_updated
AFTER UPDATE ON daily_metrics REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_daily_metrics_updated();
CREATE TRIGGER daily_metrics_weekly_insight_sources_deleted
AFTER DELETE ON daily_metrics REFERENCING OLD TABLE AS deleted_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_daily_metrics_deleted();

CREATE TRIGGER runs_weekly_insight_sources_inserted
AFTER INSERT ON runs REFERENCING NEW TABLE AS inserted_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_sources_inserted();
CREATE TRIGGER runs_weekly_insight_sources_updated
AFTER UPDATE ON runs REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_runs_updated();
CREATE TRIGGER runs_weekly_insight_sources_deleted
AFTER DELETE ON runs REFERENCING OLD TABLE AS deleted_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_sources_deleted_by_instant();

CREATE TRIGGER run_summaries_weekly_insight_sources_inserted
AFTER INSERT ON run_summaries REFERENCING NEW TABLE AS changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_run_summaries_changed();
CREATE TRIGGER run_summaries_weekly_insight_sources_updated
AFTER UPDATE ON run_summaries REFERENCING NEW TABLE AS changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_run_summaries_changed();
CREATE TRIGGER run_summaries_weekly_insight_sources_deleted
AFTER DELETE ON run_summaries REFERENCING OLD TABLE AS deleted_rows
FOR EACH STATEMENT EXECUTE FUNCTION app_private.weekly_insight_run_summaries_changed();

-- 4. Restore replays. The original functions keep their bodies, outcomes and record-version checks under a new name;
-- the public names wrap them and add the conservative invalidation for an erased record that is already absent.
ALTER FUNCTION app_private.reapply_erasure(text, uuid, uuid, uuid, timestamptz)
  RENAME TO reapply_erasure_record;
ALTER FUNCTION app_private.reapply_journaled_deletion(uuid, uuid, uuid, timestamptz, timestamptz)
  RENAME TO reapply_journaled_deletion_record;

CREATE FUNCTION app_private.reapply_erasure(
  target_entity_type text,
  target_org_id uuid,
  target_record_id uuid,
  ledger_owner_user_id uuid,
  ledger_record_created_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  outcome text;
BEGIN
  outcome := app_private.reapply_erasure_record(
    target_entity_type, target_org_id, target_record_id, ledger_owner_user_id, ledger_record_created_at
  );
  -- 'erased' already fired the week-precise triggers. Whatever the outcome, the entry does not say which week the
  -- erased record was in, so every insight of its owner that could have read it (created at or after the record) is
  -- invalidated too. The same for every outcome, so a second replay of the entry finds nothing more to delete.
  PERFORM app_private.advance_weekly_insight_source(target_org_id, ledger_owner_user_id);
  DELETE FROM public.weekly_insights AS insight
  WHERE insight.org_id = target_org_id
    AND insight.user_id = ledger_owner_user_id
    AND insight.created_at >= ledger_record_created_at;
  RETURN outcome;
END;
$$;

CREATE FUNCTION app_private.reapply_journaled_deletion(
  target_org_id uuid,
  target_run_id uuid,
  journal_owner_user_id uuid,
  journal_deleted_at timestamptz,
  effective_now timestamptz
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  outcome text;
BEGIN
  outcome := app_private.reapply_journaled_deletion_record(
    target_org_id, target_run_id, journal_owner_user_id, journal_deleted_at, effective_now
  );
  -- The journal does not carry the run's creation instant or start: every insight of its owner in the organization is
  -- invalidated, for every outcome (so a second replay is a no-op), except when the organization does not exist here.
  IF outcome <> 'skipped_unknown_organization' THEN
    PERFORM app_private.invalidate_weekly_insights_for_owner(target_org_id, journal_owner_user_id);
  END IF;
  RETURN outcome;
END;
$$;

REVOKE ALL ON FUNCTION app_private.reapply_erasure_record(text, uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.reapply_journaled_deletion_record(uuid, uuid, uuid, timestamptz, timestamptz)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.reapply_erasure(text, uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.reapply_journaled_deletion(uuid, uuid, uuid, timestamptz, timestamptz)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

COMMENT ON FUNCTION app_private.reapply_erasure(text, uuid, uuid, uuid, timestamptz) IS
  'Restore-time replay of one exported erasure (ADR-0073), owner only, idempotent. Same outcomes as reapply_erasure_record; for every outcome also invalidates the weekly insights of the ledger owner in the organization created at or after the erased record (ADR-0076), because the entry does not identify the week.';
COMMENT ON FUNCTION app_private.reapply_journaled_deletion(uuid, uuid, uuid, timestamptz, timestamptz) IS
  'Owner-only restore-time reapplication of one exported run deletion (ADR-0037), idempotent. Same outcomes as reapply_journaled_deletion_record; for every outcome except an unknown organization also invalidates every weekly insight of the journal owner in the organization (ADR-0076), because the entry does not identify the week.';
