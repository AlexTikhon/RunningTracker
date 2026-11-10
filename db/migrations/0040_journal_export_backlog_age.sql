-- ADR-0037 / ADR-0073: how far behind the off-host export is, measured instead of assumed.
--
-- A deletion or an erasure is protected against a restore from an older backup only once its outbox row has been
-- exported. One export cycle takes at most one batch (500 rows) and the next cycle waits a full interval, so with a
-- backlog the recovery window is one interval plus the time to drain the rows ahead, even while every cycle succeeds.
-- The last-success timestamp of the export task cannot show that. These two read-only capabilities return the age, in
-- seconds, of the oldest row still waiting in each outbox (0 when it is empty); the maintenance process publishes them
-- after every export cycle as journal_export_oldest_unexported_age_seconds.
--
-- Both ages use the database clock on both sides (the rows are stamped with statement_timestamp()). They read the
-- outbox without locking it, so a batch that a concurrent exporter has claimed but not yet committed still counts as
-- unexported, which is what it is until that COMMIT. The outboxes are small while the exporter keeps up; min() over
-- them needs no index. Nothing about the outboxes, their export, their file format or their replay changes.

CREATE FUNCTION app_private.erasure_ledger_oldest_unexported_age_seconds()
RETURNS double precision
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
           GREATEST(EXTRACT(EPOCH FROM statement_timestamp() - min(entry.erased_at)), 0),
           0
         )::double precision
  FROM public.erasure_ledger AS entry
$$;

REVOKE ALL ON FUNCTION app_private.erasure_ledger_oldest_unexported_age_seconds()
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.erasure_ledger_oldest_unexported_age_seconds()
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.erasure_ledger_oldest_unexported_age_seconds() IS
  'Maintenance-only. Age in seconds of the oldest erasure_ledger row not yet exported off-host, 0 when the ledger is empty. Returns no identifiers.';

CREATE FUNCTION app_private.run_deletion_journal_oldest_unexported_age_seconds()
RETURNS double precision
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
           GREATEST(EXTRACT(EPOCH FROM statement_timestamp() - min(entry.deleted_at)), 0),
           0
         )::double precision
  FROM public.run_deletion_journal AS entry
$$;

REVOKE ALL ON FUNCTION app_private.run_deletion_journal_oldest_unexported_age_seconds()
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.run_deletion_journal_oldest_unexported_age_seconds()
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.run_deletion_journal_oldest_unexported_age_seconds() IS
  'Maintenance-only. Age in seconds of the oldest run_deletion_journal row not yet exported off-host, 0 when the journal is empty. Returns no identifiers.';
