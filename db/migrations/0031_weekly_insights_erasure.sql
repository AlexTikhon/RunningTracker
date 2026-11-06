-- Derived-data erasure for weekly insights (ADR-0076). An insight is computed from a person's check-ins, activities and
-- GPS runs of one week. When one of those records is deleted, the insights of its week are deleted in the SAME
-- statement, through AFTER DELETE triggers, so no deletion path can leave a derived copy behind:
--   - the API's owner deletions (activities, check-in days, runs through app_private.execute_run_deletion), and
--     annual run retention;
--   - the restore replays: app_private.reapply_erasure (ADR-0073) deletes an erased activity or check-in day again,
--     and app_private.reapply_journaled_deletion (ADR-0037) deletes a journaled run again, so a restored backup loses
--     the insights of every week that contains an erased record. A replay that finds the record absent deletes
--     nothing, so a second replay is a no-op for insights too.
-- A check-in day whose values are changed (PUT replace) also deletes its week's insights: the insight may quote a value
-- that no longer exists, for example a weight the person has cleared. An exact retry changes no row and fires nothing.
--
-- The week of a record: a check-in day by its stored calendar date (`week_start <= local_date < week_start + 7`); an
-- activity or a run by its start instant, inside the insight's stored `[range_start, range_end)`. No zone arithmetic
-- happens here (migration 0030 explains why).
--
-- SECURITY DEFINER, like the erasure-ledger triggers: the deleting role may be the runtime role under RLS, the
-- maintenance role (retention), or the object owner (replay); the function deletes by the record's owner and
-- organization explicitly, whoever runs the statement. The erasure ledger, its file format and its replay function are
-- unchanged: insights are not journaled, they are re-derived from what survives.

CREATE FUNCTION app_private.erase_weekly_insights_for_activity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  DELETE FROM public.weekly_insights AS insight
  WHERE insight.org_id = OLD.org_id
    AND insight.user_id = OLD.user_id
    AND insight.range_start <= OLD.started_at
    AND OLD.started_at < insight.range_end;
  RETURN NULL;
END;
$$;

CREATE FUNCTION app_private.erase_weekly_insights_for_daily_metric()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  DELETE FROM public.weekly_insights AS insight
  WHERE insight.org_id = OLD.org_id
    AND insight.user_id = OLD.user_id
    AND insight.week_start <= OLD.local_date
    AND OLD.local_date < insight.week_start + 7;
  RETURN NULL;
END;
$$;

CREATE FUNCTION app_private.erase_weekly_insights_for_run()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  DELETE FROM public.weekly_insights AS insight
  WHERE insight.org_id = OLD.org_id
    AND insight.user_id = OLD.user_id
    AND insight.range_start <= OLD.started_at
    AND OLD.started_at < insight.range_end;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_private.erase_weekly_insights_for_activity()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.erase_weekly_insights_for_daily_metric()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.erase_weekly_insights_for_run()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER activities_erase_weekly_insights
AFTER DELETE ON activities
FOR EACH ROW
EXECUTE FUNCTION app_private.erase_weekly_insights_for_activity();

CREATE TRIGGER daily_metrics_erase_weekly_insights
AFTER DELETE ON daily_metrics
FOR EACH ROW
EXECUTE FUNCTION app_private.erase_weekly_insights_for_daily_metric();

CREATE TRIGGER daily_metrics_change_erases_weekly_insights
AFTER UPDATE ON daily_metrics
FOR EACH ROW
WHEN (
  (OLD.weight_kg, OLD.sleep_minutes, OLD.sleep_quality, OLD.mood, OLD.soreness)
  IS DISTINCT FROM
  (NEW.weight_kg, NEW.sleep_minutes, NEW.sleep_quality, NEW.mood, NEW.soreness)
)
EXECUTE FUNCTION app_private.erase_weekly_insights_for_daily_metric();

CREATE TRIGGER runs_erase_weekly_insights
AFTER DELETE ON runs
FOR EACH ROW
EXECUTE FUNCTION app_private.erase_weekly_insights_for_run();
