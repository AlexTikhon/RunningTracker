-- Erasure ledger for owner-only health data (ADR-0073). A restored backup must not bring back a record that its owner
-- deleted after the backup was taken. Activities (ADR-0072) are hard-deleted without a tombstone, so the deletion has
-- to be recorded outside the row itself, and the record has to leave the database host.
--
-- The same shape as the run deletion journal (ADR-0037), generalised by an entity type:
--   1. Every DELETE of an activity writes one ledger row in the SAME statement, through an AFTER DELETE trigger. It is
--      a trigger, not service code, so no path can delete an activity without its ledger row: the API, an owner's SQL
--      and the restore replay below all journal. If the ledger insert fails, the DELETE fails and rolls back; an
--      erasure without its record cannot commit.
--   2. Maintenance exports the rows to the off-host journal directory (DELETION_JOURNAL_DIR) and removes them only
--      after the file is durable (claim and acknowledge in one transaction).
--   3. After a restore, `npm run restore:reapply-erasures` replays the exported entries idempotently.
--
-- A row holds identifiers and two timestamps only: the entity type, the organization, the record id, the owner, the
-- record's creation instant and the erasure instant. No activity content (type, times, distance, effort, notes).
-- `record_created_at` identifies the exact version of the record that was erased: a later record that reuses the id
-- (activities have no tombstone, so the id becomes free again) has a different creation instant and is left alone.
--
-- Extension point for the next entity (daily_metrics): add its name to erasure_ledger_entity_type_known, a trigger like
-- activities_record_erasure on its table, and an ELSIF branch in app_private.reapply_erasure. Nothing else changes.
--
-- TRUNCATE fires no row trigger and is not journaled. The runtime role has no TRUNCATE privilege; the object owner
-- uses it only in the load-test seeder on a _load_test database.
CREATE TABLE erasure_ledger (
  ledger_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL,
  org_id uuid NOT NULL,
  record_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  record_created_at timestamptz NOT NULL,
  erased_at timestamptz NOT NULL,
  CONSTRAINT erasure_ledger_entity_type_known CHECK (entity_type IN ('activity')),
  CONSTRAINT erasure_ledger_times_finite CHECK (isfinite(record_created_at) AND isfinite(erased_at))
);

COMMENT ON TABLE erasure_ledger IS
  'Outbox of erasures of owner-only records awaiting durable export outside the database host (ADR-0073). Written only by erasure triggers in the deleting statement; drained only by the maintenance export capability after the export is durable. Identifiers and timestamps only. No foreign keys: a row must outlive the record, the membership and the organization it names.';

ALTER TABLE erasure_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE erasure_ledger FROM PUBLIC;
REVOKE ALL ON TABLE erasure_ledger FROM running_tracker_runtime;
REVOKE ALL ON TABLE erasure_ledger FROM running_tracker_maintenance;

-- 1. Record every activity erasure in the deleting statement. SECURITY DEFINER: the runtime role deletes its own rows
-- under RLS but has no privilege on the ledger.
CREATE FUNCTION app_private.record_activity_erasure()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
  VALUES ('activity', OLD.org_id, OLD.id, OLD.user_id, OLD.created_at, pg_catalog.statement_timestamp());
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_private.record_activity_erasure()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER activities_record_erasure
AFTER DELETE ON activities
FOR EACH ROW
EXECUTE FUNCTION app_private.record_activity_erasure();

-- 2. Maintenance export capability, as for the run deletion journal (migration 0018): one transaction claims a
-- bounded batch with FOR UPDATE SKIP LOCKED, writes it durably outside the database, acknowledges it and commits.
-- A crash before COMMIT leaves the rows; export is at-least-once and replay is idempotent.
CREATE FUNCTION app_private.claim_erasure_ledger_batch(batch_limit integer)
RETURNS TABLE (
  ledger_seq bigint,
  entity_type text,
  org_id uuid,
  record_id uuid,
  owner_user_id uuid,
  record_created_at timestamptz,
  erased_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF batch_limit < 1 OR batch_limit > 1000 THEN
    RAISE EXCEPTION 'erasure ledger batch limit must be between 1 and 1000: %', batch_limit
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT entry.ledger_seq, entry.entity_type, entry.org_id, entry.record_id, entry.owner_user_id,
         entry.record_created_at, entry.erased_at
  FROM public.erasure_ledger AS entry
  ORDER BY entry.ledger_seq
  LIMIT batch_limit
  FOR UPDATE SKIP LOCKED;
END;
$$;

REVOKE ALL ON FUNCTION app_private.claim_erasure_ledger_batch(integer)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.claim_erasure_ledger_batch(integer)
  TO running_tracker_maintenance;

CREATE FUNCTION app_private.ack_erasure_ledger_batch(acknowledged_seqs bigint[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  acknowledged_count integer;
BEGIN
  IF pg_catalog.cardinality(acknowledged_seqs) > 1000 THEN
    RAISE EXCEPTION 'erasure ledger acknowledgement is limited to 1000 rows'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.erasure_ledger AS entry
  WHERE entry.ledger_seq = ANY (acknowledged_seqs);
  GET DIAGNOSTICS acknowledged_count = ROW_COUNT;

  RETURN acknowledged_count;
END;
$$;

REVOKE ALL ON FUNCTION app_private.ack_erasure_ledger_batch(bigint[])
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.ack_erasure_ledger_batch(bigint[])
  TO running_tracker_maintenance;

-- 3. Restore-time replay. Granted to nobody: only the object owner (the migration role) can run it, against a restored
-- database that is not yet open to the application. Outcomes:
--   erased                    the exact erased record is in the restored data: it is deleted again (and, through
--                             the trigger, journaled again on the recovered node)
--   absent                    no record with this id: nothing to do (already erased, or never in the backup)
--   skipped_different_record  a record with this id exists but is a different one (another creation instant or
--                             owner): it reused the id after the erasure and is left alone
-- Replaying the same entry again is therefore a no-op ('absent').
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
  stored_owner uuid;
  stored_created_at timestamptz;
BEGIN
  IF target_entity_type IS NULL
    OR target_org_id IS NULL
    OR target_record_id IS NULL
    OR ledger_owner_user_id IS NULL
    OR ledger_record_created_at IS NULL
  THEN
    RAISE EXCEPTION 'erasure replay arguments must be non-null'
      USING ERRCODE = '22004';
  END IF;

  IF target_entity_type = 'activity' THEN
    SELECT activity.user_id, activity.created_at
    INTO stored_owner, stored_created_at
    FROM public.activities AS activity
    WHERE activity.org_id = target_org_id
      AND activity.id = target_record_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN 'absent';
    END IF;
    IF stored_owner <> ledger_owner_user_id OR stored_created_at <> ledger_record_created_at THEN
      RETURN 'skipped_different_record';
    END IF;

    DELETE FROM public.activities AS activity
    WHERE activity.org_id = target_org_id
      AND activity.id = target_record_id;
    RETURN 'erased';
  END IF;

  -- The next owner-only entity adds its ELSIF branch above.
  RAISE EXCEPTION 'unknown erasure entity type: %', target_entity_type
    USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION app_private.reapply_erasure(text, uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

COMMENT ON FUNCTION app_private.reapply_erasure(text, uuid, uuid, uuid, timestamptz) IS
  'Restore-time replay of one exported erasure (ADR-0073). Owner only. Deletes the exact erased record version if it is present (erased), does nothing when it is absent (absent), and leaves a record that reused the id alone (skipped_different_record). Idempotent.';
