-- Daily check-in metrics, owner-only health data (ADR-0074). Step 2 of the activity/health direction
-- (docs/product-direction.md). One row per person per local calendar date, with explicit nullable columns.
--
-- Access: the same owner-only template as activities (ADR-0072). Every policy requires the current organization, the
-- current identity as the owner and an active membership; run sharing is never consulted, so a coach or a grantee
-- sees nothing, and the maintenance role has no privilege at all.
--
-- Unlike activities, a day is replaced in place (PUT), so the runtime role may UPDATE, but only the six value
-- columns. It cannot write the identifier, the owner, the date, the time zone of the first write or either timestamp:
--   - INSERT is granted on the columns the application supplies; `id`, `created_at` and `updated_at` always take their
--     database defaults (gen_random_uuid(), clock_timestamp()), never the application clock;
--   - UPDATE is granted on the value columns only; the BEFORE UPDATE trigger sets `updated_at` from clock_timestamp().
-- So the creation instant that identifies the erased version in the erasure ledger (ADR-0073) is the database's.
--
-- `local_date` is a calendar date as the person read it, with `time_zone` the IANA zone of the first write. A later
-- change of zone never rewrites a row. The "not after today in the person's zone" rule depends on a clock and is
-- enforced by the service against its injected clock, deliberately not here (as for activities.started_at): a CHECK
-- using now() would be revalidated against another clock when a dump is restored. Only the static lower bound is a
-- CHECK.
CREATE TABLE daily_metrics (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  local_date date NOT NULL,
  time_zone text NOT NULL,
  weight_kg numeric(5, 2),
  sleep_minutes integer,
  sleep_quality smallint,
  mood smallint,
  soreness smallint,
  note text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT daily_metrics_owner_date_unique UNIQUE (org_id, user_id, local_date),
  CONSTRAINT daily_metrics_owner_membership_fk
    FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT daily_metrics_local_date_range CHECK (isfinite(local_date) AND local_date >= date '2000-01-01'),
  -- The platform's zone database decides which names exist (the service checks); this only keeps the shape sane.
  CONSTRAINT daily_metrics_time_zone_shape CHECK (
    char_length(time_zone) BETWEEN 1 AND 64 AND time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'
  ),
  -- numeric(5,2) accepts 'NaN', which PostgreSQL orders above every value, so the upper bound excludes it.
  CONSTRAINT daily_metrics_weight_range CHECK (weight_kg IS NULL OR (weight_kg >= 20 AND weight_kg <= 400)),
  CONSTRAINT daily_metrics_sleep_minutes_range CHECK (sleep_minutes IS NULL OR sleep_minutes BETWEEN 0 AND 1440),
  CONSTRAINT daily_metrics_sleep_quality_range CHECK (sleep_quality IS NULL OR sleep_quality BETWEEN 1 AND 5),
  CONSTRAINT daily_metrics_mood_range CHECK (mood IS NULL OR mood BETWEEN 1 AND 5),
  CONSTRAINT daily_metrics_soreness_range CHECK (soreness IS NULL OR soreness BETWEEN 0 AND 10),
  CONSTRAINT daily_metrics_note_length CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  CONSTRAINT daily_metrics_some_value CHECK (
    num_nonnulls(weight_kg, sleep_minutes, sleep_quality, mood, soreness, note) >= 1
  ),
  CONSTRAINT daily_metrics_times_finite CHECK (isfinite(created_at) AND isfinite(updated_at))
);

COMMENT ON TABLE daily_metrics IS
  'Owner-only daily check-in values (ADR-0074): one row per person, organization and local date. No coach or grantee access. Replaced in place; created_at/updated_at come from the database clock. Every DELETE is recorded in erasure_ledger (ADR-0073).';
COMMENT ON COLUMN daily_metrics.time_zone IS
  'IANA zone in which local_date was first written. Never rewritten, also not when the person later uses another zone.';

ALTER TABLE daily_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY daily_metrics_select_owner
ON daily_metrics
FOR SELECT
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY daily_metrics_insert_owner
ON daily_metrics
FOR INSERT
TO running_tracker_runtime
WITH CHECK (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY daily_metrics_update_owner
ON daily_metrics
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

CREATE POLICY daily_metrics_delete_owner
ON daily_metrics
FOR DELETE
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

REVOKE ALL ON TABLE daily_metrics FROM PUBLIC;
REVOKE ALL ON TABLE daily_metrics FROM running_tracker_runtime;
REVOKE ALL ON TABLE daily_metrics FROM running_tracker_maintenance;
GRANT SELECT, DELETE ON TABLE daily_metrics TO running_tracker_runtime;
GRANT INSERT (org_id, user_id, local_date, time_zone, weight_kg, sleep_minutes, sleep_quality, mood, soreness, note)
  ON TABLE daily_metrics TO running_tracker_runtime;
GRANT UPDATE (weight_kg, sleep_minutes, sleep_quality, mood, soreness, note)
  ON TABLE daily_metrics TO running_tracker_runtime;

-- updated_at follows the database clock on every replacement. Only UPDATE: a restore loads rows with COPY, which must
-- keep the stored instants, and an insert takes the column default.
CREATE FUNCTION app_private.touch_daily_metrics_updated_at()
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

REVOKE ALL ON FUNCTION app_private.touch_daily_metrics_updated_at()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER daily_metrics_touch_updated_at
BEFORE UPDATE ON daily_metrics
FOR EACH ROW
EXECUTE FUNCTION app_private.touch_daily_metrics_updated_at();

-- Erasure ledger extension point (ADR-0073), part 1 of 3: the entity type is known.
ALTER TABLE erasure_ledger DROP CONSTRAINT erasure_ledger_entity_type_known;
ALTER TABLE erasure_ledger
  ADD CONSTRAINT erasure_ledger_entity_type_known CHECK (entity_type IN ('activity', 'daily_metric'));

-- Part 2 of 3: every DELETE of a day is recorded in the deleting statement. The version is the row id and its
-- creation instant: a day deleted and written again later is a new row with a new id, which replay leaves alone.
CREATE FUNCTION app_private.record_daily_metric_erasure()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
  VALUES ('daily_metric', OLD.org_id, OLD.id, OLD.user_id, OLD.created_at, pg_catalog.statement_timestamp());
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_private.record_daily_metric_erasure()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER daily_metrics_record_erasure
AFTER DELETE ON daily_metrics
FOR EACH ROW
EXECUTE FUNCTION app_private.record_daily_metric_erasure();

-- Part 3 of 3: the replay branch. CREATE OR REPLACE keeps the owner, the privileges (granted to nobody) and the
-- comment of migration 0026; the activity branch is unchanged.
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
  END IF;

  -- The next owner-only entity adds its ELSIF branch above.
  RAISE EXCEPTION 'unknown erasure entity type: %', target_entity_type
    USING ERRCODE = '22023';
END;
$$;
