-- P10.4: tombstone lifetime and late-retry contract. See ADR-0036.
--
-- Contract in one paragraph: a tombstone row is the authoritative deletion
-- marker for as long as it exists. expires_at is the earliest instant the
-- marker MAY be reclaimed, not an instant at which the runtime stops honouring
-- it. Run-ID reuse becomes possible only after a maintenance reclaim has
-- actually removed the row. Nothing here creates a permanent used-ID registry.

-- 1. Re-deleting an ID whose previous tombstone still exists must not fail.
--
-- A run ID is unique per organization, but the runtime tombstone SELECT policy
-- is owner-scoped: a different member's PUT cannot see someone else's marker
-- and may legitimately create a live run under an ID that carries another
-- member's tombstone. Deleting that run must still succeed (and annual
-- retention must never wedge on a plain PRIMARY KEY violation). The newer
-- deletion therefore takes over the marker; the protection window can only be
-- extended, never shortened, by a takeover.
CREATE OR REPLACE FUNCTION app_private.execute_run_deletion(
  target_org_id uuid,
  target_run_id uuid,
  deleting_owner_user_id uuid,
  effective_now timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  has_summary boolean;
  new_archive_revision bigint;
BEGIN
  INSERT INTO public.run_tombstones AS tombstone (
    org_id, run_id, owner_user_id, deleted_at, expires_at
  )
  VALUES (
    target_org_id,
    target_run_id,
    deleting_owner_user_id,
    effective_now,
    effective_now + interval '1 year'
  )
  ON CONFLICT (org_id, run_id) DO UPDATE
  SET owner_user_id = EXCLUDED.owner_user_id,
      deleted_at = EXCLUDED.deleted_at,
      expires_at = GREATEST(tombstone.expires_at, EXCLUDED.expires_at);

  SELECT EXISTS (
    SELECT 1
    FROM public.run_summaries AS summary
    WHERE summary.org_id = target_org_id
      AND summary.run_id = target_run_id
  ) INTO has_summary;

  -- Deleting the summary first lets its existing AFTER DELETE trigger
  -- (migration 0013, advance_archive_revision_for_summary_delete) perform
  -- the single required archive-revision increment for this run. run_shares
  -- is deleted next, explicitly, so that its own history-grant trigger
  -- (advance_archive_revision_for_history_share) observes that the summary
  -- row is already gone and therefore does not add a second increment. If
  -- both deletes were instead left to FK ON DELETE CASCADE from the run row,
  -- their relative firing order would be unspecified and could double-count.
  DELETE FROM public.run_summaries AS summary
  WHERE summary.org_id = target_org_id
    AND summary.run_id = target_run_id;

  DELETE FROM public.run_shares AS share
  WHERE share.org_id = target_org_id
    AND share.run_id = target_run_id;

  -- run_points and run_commands carry no archive-revision trigger, so the
  -- ordinary FK ON DELETE CASCADE from the run row is sufficient for them.
  DELETE FROM public.runs AS run
  WHERE run.org_id = target_org_id
    AND run.id = target_run_id;

  IF NOT has_summary THEN
    UPDATE public.organizations AS organization
    SET archive_revision = organization.archive_revision + 1
    WHERE organization.id = target_org_id;
  END IF;

  SELECT organization.archive_revision
  INTO new_archive_revision
  FROM public.organizations AS organization
  WHERE organization.id = target_org_id;

  RETURN new_archive_revision;
END;
$$;

REVOKE ALL ON FUNCTION app_private.execute_run_deletion(uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

COMMENT ON FUNCTION app_private.execute_run_deletion(uuid, uuid, uuid, timestamptz) IS
  'Shared trusted deletion primitive used by both owner and annual-retention deletion. Assumes the caller already holds the per-run advisory lock and locked organization/run rows and has confirmed authorization/eligibility. Writes the tombstone (a newer deletion takes over an existing marker for the same run ID and never shortens its expiry), deletes run_summaries before run_shares so exactly one archive-revision increment occurs regardless of whether a summary existed, then deletes the run, cascading run_points/run_commands.';

-- 2. Bounded, restart-safe reclamation of expired tombstones.
--
-- The tombstone row is the only serialization point. Its writers are exactly
-- two: execute_run_deletion (insert / takeover, above) and this function
-- (delete). Row locks therefore order them without any advisory lock, and the
-- tombstone row is the last lock either path takes, so no lock cycle exists.
--   * FOR UPDATE SKIP LOCKED: a second reclaim worker, or a reclaim racing a
--     deletion that is taking the marker over, skips the row instead of
--     waiting, so workers never process the same marker and never block each
--     other.
--   * The DELETE re-checks expires_at <= effective_now against the locked row
--     version, so a marker that a newer deletion just extended is never
--     removed on the strength of a stale scan.
--   * State lives only in PostgreSQL. A crashed or rolled-back call leaves
--     every marker untouched, and re-running it is harmless.
CREATE FUNCTION app_private.reclaim_expired_run_tombstones(
  effective_now timestamptz,
  reclaim_batch_limit integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  reclaimed_count integer;
BEGIN
  IF NOT pg_catalog.isfinite(effective_now) THEN
    RAISE EXCEPTION 'tombstone reclaim time must be finite'
      USING ERRCODE = '22007';
  END IF;
  IF reclaim_batch_limit < 1 OR reclaim_batch_limit > 1000 THEN
    RAISE EXCEPTION 'tombstone reclaim batch limit must be between 1 and 1000: %',
      reclaim_batch_limit
      USING ERRCODE = '22023';
  END IF;

  WITH candidate AS (
    SELECT tombstone.org_id, tombstone.run_id
    FROM public.run_tombstones AS tombstone
    WHERE tombstone.expires_at <= effective_now
    ORDER BY tombstone.expires_at, tombstone.org_id, tombstone.run_id
    LIMIT reclaim_batch_limit
    FOR UPDATE SKIP LOCKED
  ),
  reclaimed AS (
    DELETE FROM public.run_tombstones AS tombstone
    USING candidate
    WHERE tombstone.org_id = candidate.org_id
      AND tombstone.run_id = candidate.run_id
      AND tombstone.expires_at <= effective_now
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO reclaimed_count FROM reclaimed;

  RETURN reclaimed_count;
END;
$$;

REVOKE ALL ON FUNCTION app_private.reclaim_expired_run_tombstones(timestamptz, integer)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.reclaim_expired_run_tombstones(timestamptz, integer)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.reclaim_expired_run_tombstones(timestamptz, integer) IS
  'Maintenance-only. Deletes at most reclaim_batch_limit (1..1000) tombstones with expires_at <= effective_now, oldest first, skipping rows locked by any other transaction and re-checking expiry on the locked row. It is the only way a tombstone is removed, so it is the only way a deleted run ID becomes reusable. Returns the number of markers removed.';

COMMENT ON TABLE run_tombstones IS
  'Deletion markers without run payload or coordinates. A marker is authoritative while the row exists: PUT returns 410 and the owner DELETE stays idempotent. expires_at (deleted_at + 1 year, set by the deletion primitive) is the earliest instant app_private.reclaim_expired_run_tombstones may remove the row; after removal the run ID is reusable and no guarantee applies. This table has no foreign key to runs.';
