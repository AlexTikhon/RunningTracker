-- Erasure replay of daily movement leaves weekly insights alone (ADR-0078).
--
-- Migration 0032 made app_private.reapply_erasure a wrapper: after the record-level replay it advances the ledger
-- owner's weekly insight source gate and deletes the owner's insights created at or after the erased record, for every
-- outcome, because an erasure-ledger entry does not say which week its record was in. That is right for activities and
-- check-in days, which are insight sources. Daily movement is not an insight source (the facts bundle, the input hash
-- and the policies of ADR-0076 do not read it), so replaying a movement erasure must change no insight and no gate
-- revision: otherwise restoring a backup would invalidate AI insights that never read the erased record.
--
-- The record-level replay (reapply_erasure_record, extended in 0033), its outcomes and its version check are
-- unchanged; only the wrapper's insight step is skipped for 'daily_movement'.
--
-- Kept as its own migration on purpose: the restore drill restores a backup taken one migration behind the repository
-- (ADR-0074), so with this split that backup already contains daily_movement rows and the drill proves a movement
-- erasure through a real pg_dump/pg_restore. Until this migration runs, a movement replay would only invalidate more
-- insights than necessary (derived data, conservative), never fewer.
CREATE OR REPLACE FUNCTION app_private.reapply_erasure(
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
  -- Not an insight source: nothing derived from it exists, so nothing derived is invalidated.
  IF target_entity_type = 'daily_movement' THEN
    RETURN outcome;
  END IF;
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

COMMENT ON FUNCTION app_private.reapply_erasure(text, uuid, uuid, uuid, timestamptz) IS
  'Restore-time replay of one exported erasure (ADR-0073), owner only, idempotent. Same outcomes as reapply_erasure_record; for an activity or check-in entry also invalidates the weekly insights of the ledger owner in the organization created at or after the erased record (ADR-0076), because the entry does not identify the week. A daily_movement entry (ADR-0078) touches no insight: movement is not an insight source.';
