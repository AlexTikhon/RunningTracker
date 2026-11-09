-- Manual meal log, owner-only health data (ADR-0083): one row per meal or snack the person logged by hand for a local
-- calendar date. Its nutrition values are the person's own totals for the whole entry (not per 100 g, not per serving),
-- every one of them optional: a title-only entry is valid, a missing value is unknown (NULL) and a recorded 0 is a value.
-- Nothing is looked up, parsed, estimated or interpreted here or anywhere else.
--
-- Access: the owner-only template of daily_metrics and daily_movement (ADR-0074, ADR-0078). Every policy requires the
-- current organization, the current identity as the owner and an active membership; run sharing is never consulted, so
-- a coach or a grantee sees nothing, and the maintenance role has no privilege at all.
--
-- Column privileges of the runtime role:
--   - INSERT on the columns the application supplies; `id`, `source`, `created_at` and `updated_at` always take their
--     database defaults (gen_random_uuid(), 'manual', clock_timestamp()). The client therefore cannot choose an id,
--     another owner (RLS), another organization (RLS) or another provenance (no privilege on `source`);
--   - UPDATE on the editable columns only: meal type, title and the four nutrition values. The identity, the owner,
--     the date, the zone of the first write, the idempotency key, the creation digest and both timestamps are
--     immutable for the application; the BEFORE UPDATE trigger sets `updated_at` from clock_timestamp().
--
-- Idempotent creation (ADR-0073's pattern, with a database-generated id): the client sends one idempotency key per form
-- session. It is unique per owner and organization, so a second POST of the same form session can never create a
-- second entry. `creation_digest` is the SHA-256 of the canonical creation request, computed by the API: a retry with
-- the same key is "the same payload" exactly when its digest equals the stored one, also after the entry was edited
-- (the original request is what a retry repeats, not the current values). A deleted entry frees its key.
--
-- Values: unconstrained numeric plus explicit CHECKs, never numeric(p,s): a type modifier rounds a value before the
-- CHECK constraints run (migration 0035), and an entry must store exactly what the contract accepted. Each value is
-- 0 to its technical bound with at most one meaningful decimal; NaN and infinities fail the range checks (numeric
-- orders NaN above every value and Infinity above every finite one; -Infinity fails the lower bound). The bounds are
-- technical (typing slips, overflow), not dietary judgements, and are the constants of packages/contracts/src/meals.ts:
--   energy_kcal       0 to 20,000 kcal
--   protein_g         0 to 2,000 g
--   carbohydrate_g    0 to 2,000 g
--   fat_g             0 to 2,000 g
--
-- `local_date` and `time_zone` follow ADR-0074: a calendar date as the person read it, and the IANA zone of the first
-- write, never rewritten. "Not after today in the person's zone" depends on a clock and is enforced by the service.
--
-- Not an AI insight source: no trigger of this table touches weekly insights or their source gates, and the erasure
-- replay wrapper skips the insight step for 'meal' entries (below), as it does for daily movement (migration 0034).
CREATE TABLE meals (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  local_date date NOT NULL,
  time_zone text NOT NULL,
  meal_type text NOT NULL,
  title text NOT NULL,
  energy_kcal numeric,
  protein_g numeric,
  carbohydrate_g numeric,
  fat_g numeric,
  source text NOT NULL DEFAULT 'manual',
  idempotency_key uuid NOT NULL,
  creation_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meals_owner_idempotency_key_unique UNIQUE (org_id, user_id, idempotency_key),
  CONSTRAINT meals_owner_membership_fk
    FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT meals_local_date_range CHECK (isfinite(local_date) AND local_date >= date '2000-01-01'),
  CONSTRAINT meals_time_zone_shape CHECK (
    char_length(time_zone) BETWEEN 1 AND 64 AND time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'
  ),
  CONSTRAINT meals_meal_type_known CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack', 'other')),
  -- Code points, exactly as the contract (zod) counts them. Text cannot hold NUL at all. A title of ASCII whitespace
  -- only is refused here; the contract also refuses one of any Unicode whitespace (the stricter rule, ADR-0083).
  CONSTRAINT meals_title_shape CHECK (
    char_length(title) BETWEEN 1 AND 120 AND btrim(title, E' \t\n\r\f\v') <> ''
  ),
  -- The only provenance today. An importer adds its own value in its own migration and ADR.
  CONSTRAINT meals_source_known CHECK (source IN ('manual')),
  CONSTRAINT meals_energy_kcal_range CHECK (energy_kcal IS NULL OR (energy_kcal >= 0 AND energy_kcal <= 20000)),
  CONSTRAINT meals_energy_kcal_precision CHECK (energy_kcal IS NULL OR energy_kcal = round(energy_kcal, 1)),
  CONSTRAINT meals_protein_g_range CHECK (protein_g IS NULL OR (protein_g >= 0 AND protein_g <= 2000)),
  CONSTRAINT meals_protein_g_precision CHECK (protein_g IS NULL OR protein_g = round(protein_g, 1)),
  CONSTRAINT meals_carbohydrate_g_range CHECK (
    carbohydrate_g IS NULL OR (carbohydrate_g >= 0 AND carbohydrate_g <= 2000)
  ),
  CONSTRAINT meals_carbohydrate_g_precision CHECK (carbohydrate_g IS NULL OR carbohydrate_g = round(carbohydrate_g, 1)),
  CONSTRAINT meals_fat_g_range CHECK (fat_g IS NULL OR (fat_g >= 0 AND fat_g <= 2000)),
  CONSTRAINT meals_fat_g_precision CHECK (fat_g IS NULL OR fat_g = round(fat_g, 1)),
  CONSTRAINT meals_creation_digest_sha256 CHECK (octet_length(creation_digest) = 32),
  CONSTRAINT meals_times_finite CHECK (isfinite(created_at) AND isfinite(updated_at))
);

-- One day's entries in the order they were logged (the list and the Today totals read exactly this range).
CREATE INDEX meals_owner_date_created_idx ON meals (org_id, user_id, local_date, created_at, id);

COMMENT ON TABLE meals IS
  'Owner-only manual meal log (ADR-0083): one entry per meal or snack per person, organization and local date, with optional user-reported nutrition totals for the whole entry. No coach or grantee access. Editable fields: meal_type, title and the four values. created_at/updated_at come from the database clock. Every DELETE is recorded in erasure_ledger (ADR-0073). Not an AI insight source.';
COMMENT ON COLUMN meals.energy_kcal IS
  'Food energy the person reported for the whole entry, in kcal: 0 to 20,000 with at most one meaningful decimal, refused (never rounded) otherwise. NULL is unknown. Never estimated, and never combined with active energy.';
COMMENT ON COLUMN meals.protein_g IS
  'Protein the person reported for the whole entry, in grams: 0 to 2,000 with at most one meaningful decimal. NULL is unknown.';
COMMENT ON COLUMN meals.carbohydrate_g IS
  'Carbohydrate the person reported for the whole entry, in grams: 0 to 2,000 with at most one meaningful decimal. NULL is unknown.';
COMMENT ON COLUMN meals.fat_g IS
  'Fat the person reported for the whole entry, in grams: 0 to 2,000 with at most one meaningful decimal. NULL is unknown.';
COMMENT ON COLUMN meals.source IS
  'Provenance, set by the database default and never by the application: ''manual'' only.';
COMMENT ON COLUMN meals.time_zone IS
  'IANA zone in which the entry was first written. Never rewritten.';
COMMENT ON COLUMN meals.idempotency_key IS
  'Client-generated key of the form session that created the entry (ADR-0073 pattern). Unique per owner and organization. A deleted entry frees its key.';
COMMENT ON COLUMN meals.creation_digest IS
  'SHA-256 of the canonical creation request, computed by the API. A retry with the same idempotency key and the same digest returns the entry; another digest is a conflict.';

ALTER TABLE meals ENABLE ROW LEVEL SECURITY;

CREATE POLICY meals_select_owner
ON meals
FOR SELECT
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY meals_insert_owner
ON meals
FOR INSERT
TO running_tracker_runtime
WITH CHECK (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY meals_update_owner
ON meals
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

CREATE POLICY meals_delete_owner
ON meals
FOR DELETE
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

REVOKE ALL ON TABLE meals FROM PUBLIC;
REVOKE ALL ON TABLE meals FROM running_tracker_runtime;
REVOKE ALL ON TABLE meals FROM running_tracker_maintenance;
GRANT SELECT, DELETE ON TABLE meals TO running_tracker_runtime;
GRANT INSERT (
    org_id, user_id, local_date, time_zone, meal_type, title,
    energy_kcal, protein_g, carbohydrate_g, fat_g, idempotency_key, creation_digest
  )
  ON TABLE meals TO running_tracker_runtime;
GRANT UPDATE (meal_type, title, energy_kcal, protein_g, carbohydrate_g, fat_g)
  ON TABLE meals TO running_tracker_runtime;

-- updated_at follows the database clock on every edit. Only UPDATE: a restore loads rows with COPY, which must keep the
-- stored instants, and an insert takes the column default.
CREATE FUNCTION app_private.touch_meal_updated_at()
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

REVOKE ALL ON FUNCTION app_private.touch_meal_updated_at()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER meals_touch_updated_at
BEFORE UPDATE ON meals
FOR EACH ROW
EXECUTE FUNCTION app_private.touch_meal_updated_at();

-- Erasure ledger extension point (ADR-0073), part 1 of 3: the entity type is known.
ALTER TABLE erasure_ledger DROP CONSTRAINT erasure_ledger_entity_type_known;
ALTER TABLE erasure_ledger
  ADD CONSTRAINT erasure_ledger_entity_type_known
  CHECK (entity_type IN ('activity', 'daily_metric', 'daily_movement', 'meal'));

-- Part 2 of 3: every DELETE of an entry is recorded in the deleting statement; if the ledger insert fails, the DELETE
-- fails. Identifiers and the version only: never the title or a nutrition value. The version is the database-generated
-- id and its creation instant: an entry deleted and logged again (also from the same form session) is a new row with a
-- new id and a new instant, which replay leaves alone.
CREATE FUNCTION app_private.record_meal_erasure()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
  VALUES ('meal', OLD.org_id, OLD.id, OLD.user_id, OLD.created_at, pg_catalog.statement_timestamp());
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_private.record_meal_erasure()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER meals_record_erasure
AFTER DELETE ON meals
FOR EACH ROW
EXECUTE FUNCTION app_private.record_meal_erasure();

-- Part 3 of 3: the replay branch in the record-level function (renamed by 0032, extended by 0033). CREATE OR REPLACE
-- keeps its owner and its privileges (granted to nobody); the activity, check-in and movement branches are unchanged.
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
  ELSIF target_entity_type = 'meal' THEN
    SELECT meal.user_id, meal.created_at
    INTO stored_owner, stored_created_at
    FROM public.meals AS meal
    WHERE meal.org_id = target_org_id
      AND meal.id = target_record_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN 'absent';
    END IF;
    IF stored_owner <> ledger_owner_user_id OR stored_created_at <> ledger_record_created_at THEN
      RETURN 'skipped_different_record';
    END IF;

    DELETE FROM public.meals AS meal
    WHERE meal.org_id = target_org_id
      AND meal.id = target_record_id;
    RETURN 'erased';
  END IF;

  -- The next owner-only entity adds its ELSIF branch above.
  RAISE EXCEPTION 'unknown erasure entity type: %', target_entity_type
    USING ERRCODE = '22023';
END;
$$;

-- The public replay wrapper (0032, 0034): meals are not an insight source, so a meal entry, like a movement entry,
-- returns the record outcome and invalidates no insight and advances no source gate. Activity and check-in entries
-- behave exactly as before. CREATE OR REPLACE keeps the owner and the privileges (granted to nobody).
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
  -- Not insight sources: nothing derived from them exists, so nothing derived is invalidated.
  IF target_entity_type IN ('daily_movement', 'meal') THEN
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
  'Restore-time replay of one exported erasure (ADR-0073), owner only, idempotent. Same outcomes as reapply_erasure_record; for an activity or check-in entry also invalidates the weekly insights of the ledger owner in the organization created at or after the erased record (ADR-0076), because the entry does not identify the week. A daily_movement (ADR-0078) or meal (ADR-0083) entry touches no insight: neither is an insight source.';
