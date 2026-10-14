-- A Start whose requested time is ahead of the server clock. The browser clock can run fast, and creation
-- accepts a requested start up to 24 hours after the server creation time. Finish, upload windows,
-- auto-finish and retention are all governed by server time, so a run accepted with a future start and then
-- finished at once had `finished_at < started_at` and violated runs_finished_state_consistent.
--
-- The run now keeps two timestamps:
--   * requested_started_at: exactly what the client asked for. It is the creation identity: an equivalent PUT
--     replay compares against it, and the 24-hour admission bound applies to it.
--   * started_at: the effective lifecycle start, never later than created_at for a run created by the
--     application. It is what the run view, ordering, search and the finish constraint use.
-- Both are compared and normalized by PostgreSQL at its own microsecond precision.
--
-- Backfill: every existing row's stored started_at is, by construction, the value the client requested, so it
-- becomes requested_started_at unchanged. Only runs that are still active are repaired (started_at is clamped
-- to created_at). A finished archive keeps its stored started_at, its finished_at and its command results.
ALTER TABLE runs ADD COLUMN requested_started_at timestamptz;

UPDATE runs
SET requested_started_at = started_at;

UPDATE runs
SET started_at = created_at
WHERE status IN ('recording', 'paused')
  AND started_at > created_at;

ALTER TABLE runs ALTER COLUMN requested_started_at SET NOT NULL;

ALTER TABLE runs DROP CONSTRAINT runs_start_within_auto_finish_window;
ALTER TABLE runs
ADD CONSTRAINT runs_start_within_auto_finish_window CHECK (
  requested_started_at <= created_at + INTERVAL '24 hours'
);

-- Rows written without an explicit requested start (the restore drill, seed tooling, direct fixtures) keep
-- working: the requested start defaults to the stored one.
CREATE FUNCTION app_private.default_requested_started_at()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.requested_started_at := COALESCE(NEW.requested_started_at, NEW.started_at);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.default_requested_started_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.default_requested_started_at()
  FROM running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER runs_default_requested_started_at
BEFORE INSERT ON public.runs
FOR EACH ROW
EXECUTE FUNCTION app_private.default_requested_started_at();

COMMENT ON COLUMN runs.requested_started_at IS
  'The start time the client requested at creation. Creation identity for PUT replay and the subject of the 24-hour admission bound; started_at is the effective lifecycle start.';
