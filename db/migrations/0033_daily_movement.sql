-- Daily movement, owner-only health data (ADR-0078): steps and active energy that the person entered by hand for one
-- local calendar date. A dedicated table, not more columns on daily_metrics: the check-in PUT replaces a whole day
-- (ADR-0074), so new fields there would be cleared by every existing client that does not send them.
--
-- Access: the owner-only template of daily_metrics (ADR-0074). Every policy requires the current organization, the
-- current identity as the owner and an active membership; run sharing is never consulted, so a coach or a grantee
-- sees nothing, and the maintenance role has no privilege at all.
--
-- Column privileges of the runtime role:
--   - INSERT on the columns the application supplies; `id`, `source`, `created_at` and `updated_at` always take their
--     database defaults (gen_random_uuid(), 'manual', clock_timestamp()). The client therefore cannot choose another
--     owner (RLS), another organization (RLS) or another provenance (no privilege on `source`);
--   - UPDATE on the two value columns only; the BEFORE UPDATE trigger sets `updated_at` from clock_timestamp().
--
-- Provenance: `source` names where the values came from. Only 'manual' exists. The unique key includes it, so a later
-- importer (a phone or watch integration) can store its own row for the same day under its own source value without
-- overwriting the manual one; a read model then picks ONE source per day and never adds sources together (ADR-0078).
-- No importer, device identifier or sample table is created here.
--
-- Values: `steps` is a count; `active_energy_kcal` is the active energy the person reports (not resting energy, not
-- total expenditure, not food intake), with one decimal. Missing is NULL ("unknown"), and a recorded 0 is a value.
-- Nothing is derived: no energy is estimated from steps.
--
-- `local_date` and `time_zone` follow ADR-0074: a calendar date as the person read it, and the IANA zone of the first
-- write, never rewritten. "Not after today in the person's zone" depends on a clock and is enforced by the service.
CREATE TABLE daily_movement (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  local_date date NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  time_zone text NOT NULL,
  steps integer,
  active_energy_kcal numeric(6, 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT daily_movement_owner_date_source_unique UNIQUE (org_id, user_id, local_date, source),
  CONSTRAINT daily_movement_owner_membership_fk
    FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT daily_movement_local_date_range CHECK (isfinite(local_date) AND local_date >= date '2000-01-01'),
  CONSTRAINT daily_movement_time_zone_shape CHECK (
    char_length(time_zone) BETWEEN 1 AND 64 AND time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'
  ),
  -- The only provenance today. An importer adds its own value in its own migration and ADR.
  CONSTRAINT daily_movement_source_known CHECK (source IN ('manual')),
  -- Technical bounds, not health judgements: they refuse typing slips and overflow, never a plausible day.
  CONSTRAINT daily_movement_steps_range CHECK (steps IS NULL OR steps BETWEEN 0 AND 200000),
  -- numeric accepts 'NaN', which PostgreSQL orders above every value, so the upper bound excludes it (and infinity).
  CONSTRAINT daily_movement_active_energy_range CHECK (
    active_energy_kcal IS NULL OR (active_energy_kcal >= 0 AND active_energy_kcal <= 20000)
  ),
  CONSTRAINT daily_movement_some_value CHECK (num_nonnulls(steps, active_energy_kcal) >= 1),
  CONSTRAINT daily_movement_times_finite CHECK (isfinite(created_at) AND isfinite(updated_at))
);

COMMENT ON TABLE daily_movement IS
  'Owner-only daily movement (ADR-0078): steps and user-reported active energy per person, organization, local date and source. Only manual entry exists. No coach or grantee access. Replaced in place; created_at/updated_at come from the database clock. Every DELETE is recorded in erasure_ledger (ADR-0073). Not an AI insight source.';
COMMENT ON COLUMN daily_movement.source IS
  'Provenance, set by the database default and never by the application: ''manual'' only. Part of the unique key so that a later importer can keep its own row per day without overwriting the manual one.';
COMMENT ON COLUMN daily_movement.active_energy_kcal IS
  'Active energy the person reported, in kcal with one decimal. Not resting energy, total expenditure or food intake; never estimated from steps.';
COMMENT ON COLUMN daily_movement.time_zone IS
  'IANA zone in which local_date was first written. Never rewritten, also not when the person later uses another zone.';

ALTER TABLE daily_movement ENABLE ROW LEVEL SECURITY;

CREATE POLICY daily_movement_select_owner
ON daily_movement
FOR SELECT
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY daily_movement_insert_owner
ON daily_movement
FOR INSERT
TO running_tracker_runtime
WITH CHECK (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY daily_movement_update_owner
ON daily_movement
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

CREATE POLICY daily_movement_delete_owner
ON daily_movement
FOR DELETE
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

REVOKE ALL ON TABLE daily_movement FROM PUBLIC;
REVOKE ALL ON TABLE daily_movement FROM running_tracker_runtime;
REVOKE ALL ON TABLE daily_movement FROM running_tracker_maintenance;
GRANT SELECT, DELETE ON TABLE daily_movement TO running_tracker_runtime;
GRANT INSERT (org_id, user_id, local_date, time_zone, steps, active_energy_kcal)
  ON TABLE daily_movement TO running_tracker_runtime;
GRANT UPDATE (steps, active_energy_kcal)
  ON TABLE daily_movement TO running_tracker_runtime;

-- updated_at follows the database clock on every replacement. Only UPDATE: a restore loads rows with COPY, which must
-- keep the stored instants, and an insert takes the column default.
CREATE FUNCTION app_private.touch_daily_movement_updated_at()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.touch_daily_movement_updated_at()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER daily_movement_touch_updated_at
BEFORE UPDATE ON daily_movement
FOR EACH ROW
EXECUTE FUNCTION app_private.touch_daily_movement_updated_at();

-- Erasure ledger extension point (ADR-0073), part 1 of 3: the entity type is known.
ALTER TABLE erasure_ledger DROP CONSTRAINT erasure_ledger_entity_type_known;
ALTER TABLE erasure_ledger
  ADD CONSTRAINT erasure_ledger_entity_type_known CHECK (entity_type IN ('activity', 'daily_metric', 'daily_movement'));

-- Part 2 of 3: every DELETE of a movement day is recorded in the deleting statement; if the ledger insert fails, the
-- DELETE fails. The version is the row id and its creation instant (ADR-0074): a day deleted and written again later
-- is a new row with a new id and a new instant, which replay leaves alone.
CREATE FUNCTION app_private.record_daily_movement_erasure()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
  VALUES ('daily_movement', OLD.org_id, OLD.id, OLD.user_id, OLD.created_at, pg_catalog.statement_timestamp());
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_private.record_daily_movement_erasure()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER daily_movement_record_erasure
AFTER DELETE ON daily_movement
FOR EACH ROW
EXECUTE FUNCTION app_private.record_daily_movement_erasure();

-- Part 3 of 3: the replay branch, in the record-level function that migration 0032 renamed to reapply_erasure_record
-- (the public reapply_erasure wraps it; migration 0034 keeps movement replays away from weekly insights). CREATE OR
-- REPLACE keeps its owner and its privileges (granted to nobody); the activity and check-in branches are unchanged.
CREATE OR REPLACE FUNCTION app_private.reapply_erasure_record(
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
  ELSIF target_entity_type = 'daily_metric' THEN
    SELECT metric.user_id, metric.created_at
    INTO stored_owner, stored_created_at
    FROM public.daily_metrics AS metric
    WHERE metric.org_id = target_org_id
      AND metric.id = target_record_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN 'absent';
    END IF;
    IF stored_owner <> ledger_owner_user_id OR stored_created_at <> ledger_record_created_at THEN
      RETURN 'skipped_different_record';
    END IF;

    DELETE FROM public.daily_metrics AS metric
    WHERE metric.org_id = target_org_id
      AND metric.id = target_record_id;
    RETURN 'erased';
  ELSIF target_entity_type = 'daily_movement' THEN
    SELECT movement.user_id, movement.created_at
    INTO stored_owner, stored_created_at
    FROM public.daily_movement AS movement
    WHERE movement.org_id = target_org_id
      AND movement.id = target_record_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN 'absent';
    END IF;
    IF stored_owner <> ledger_owner_user_id OR stored_created_at <> ledger_record_created_at THEN
      RETURN 'skipped_different_record';
    END IF;

    DELETE FROM public.daily_movement AS movement
    WHERE movement.org_id = target_org_id
      AND movement.id = target_record_id;
    RETURN 'erased';
  END IF;

  -- The next owner-only entity adds its ELSIF branch above.
  RAISE EXCEPTION 'unknown erasure entity type: %', target_entity_type
    USING ERRCODE = '22023';
END;
$$;
