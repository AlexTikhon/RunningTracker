-- ADR-0080 / ADR-0081: authenticated-session cleanup batches are real bounds, whatever plan PostgreSQL chooses.
--
-- Migration 0036 removed expired sessions with `DELETE ... WHERE token_digest IN (SELECT ... ORDER BY expires_at
-- LIMIT n [FOR UPDATE SKIP LOCKED])`. A LIMIT inside `IN (subquery)` is not a bound: under a nested-loop semi join the
-- subquery is re-run once per outer row, and in the purge LockRows skips the rows this statement has already deleted,
-- so every rescan returns new ones. With the planner settings of the pending-login rescan regression, the purge removed
-- all 700 tied rows for a batch limit of 100 (and runSessionPurgeOnce then reported the cycle as failed after the rows
-- were gone). The creation sweep has no row lock, so a rescan re-reads the same rows, but its limit of 100 rested on
-- that executor detail and on ties coming back in the same order, not on the statement.
--
-- Both functions now choose their batch once in a MATERIALIZED CTE, ordered by expiry and then digest, and delete by
-- join: exactly the convention of migration 0037 for pending logins. Only the cleanup statements change. Signatures,
-- return types, STRICT, VOLATILE, SECURITY DEFINER, the fixed search_path, argument checks, the capacity advisory lock,
-- the unknown-user and duplicate outcomes, live counting and the refusal to evict a live session are as in 0036.
-- CREATE OR REPLACE keeps each function's owner and grants; the grants are restated anyway so this file alone shows
-- them. Applied migrations are never edited.

CREATE OR REPLACE FUNCTION app_private.create_auth_session(
  session_token_digest text,
  session_user_id uuid,
  session_csrf_token text,
  session_issued_at timestamptz,
  session_expires_at timestamptz,
  store_capacity integer
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  live_sessions integer;
BEGIN
  IF store_capacity < 1 OR store_capacity > 10000 THEN
    RAISE EXCEPTION 'session store capacity must be between 1 and 10000: %', store_capacity
      USING ERRCODE = '22023';
  END IF;
  IF NOT isfinite(session_issued_at) OR NOT isfinite(session_expires_at) THEN
    RAISE EXCEPTION 'session instants must be finite' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('running-tracker:auth-session-capacity', 0)
  );

  IF NOT EXISTS (SELECT 1 FROM public.users AS user_row WHERE user_row.id = session_user_id) THEN
    RETURN 'unknown_user';
  END IF;

  -- At most 100 rows already expired at the issue instant. The batch is chosen once (MATERIALIZED), then deleted by
  -- join, so the bound holds under any plan. As in 0036 there is no SKIP LOCKED here: creations are serialized by the
  -- advisory lock above, and a candidate inside a concurrent purge's uncommitted batch is waited for (one short
  -- statement) and then not deleted again, so a sweep may remove fewer than 100, never more.
  WITH expired AS MATERIALIZED (
    SELECT candidate.token_digest
    FROM app_private.auth_sessions AS candidate
    WHERE candidate.expires_at <= session_issued_at
    ORDER BY candidate.expires_at, candidate.token_digest
    LIMIT 100
  )
  DELETE FROM app_private.auth_sessions AS stored
  USING expired
  WHERE stored.token_digest = expired.token_digest;

  SELECT count(*)::integer
  INTO live_sessions
  FROM app_private.auth_sessions AS stored
  WHERE stored.expires_at > session_issued_at;

  IF live_sessions >= store_capacity THEN
    RETURN 'at_capacity';
  END IF;

  INSERT INTO app_private.auth_sessions (token_digest, user_id, csrf_token, issued_at, expires_at)
  VALUES (session_token_digest, session_user_id, session_csrf_token, session_issued_at, session_expires_at)
  ON CONFLICT (token_digest) DO NOTHING;
  IF NOT FOUND THEN
    RETURN 'duplicate';
  END IF;

  RETURN 'created';
END;
$$;

REVOKE ALL ON FUNCTION app_private.create_auth_session(text, uuid, text, timestamptz, timestamptz, integer)
  FROM PUBLIC, running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.create_auth_session(text, uuid, text, timestamptz, timestamptz, integer)
  TO running_tracker_runtime;

COMMENT ON FUNCTION app_private.create_auth_session(text, uuid, text, timestamptz, timestamptz, integer) IS
  'Runtime only. Inserts one session for a provisioned user when fewer than store_capacity sessions are live at its issue instant, after removing at most 100 expired rows (one materialized batch, earliest expiry then digest). Serialized by an advisory transaction lock. Never replaces an existing digest and never evicts a live session. Returns created, at_capacity, unknown_user or duplicate.';

CREATE OR REPLACE FUNCTION app_private.purge_expired_auth_sessions(effective_now timestamptz, batch_limit integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  purged integer;
BEGIN
  IF batch_limit < 1 OR batch_limit > 1000 THEN
    RAISE EXCEPTION 'session purge batch limit must be between 1 and 1000: %', batch_limit
      USING ERRCODE = '22023';
  END IF;
  IF NOT isfinite(effective_now) THEN
    RAISE EXCEPTION 'effective_now must be finite' USING ERRCODE = '22023';
  END IF;

  -- Chosen and locked once, then deleted by join, so batch_limit is a real bound whatever the plan. Rows another
  -- transaction holds (a concurrent purge's batch, a sign-in sweep, a sign-out) are skipped, not waited for.
  WITH expired AS MATERIALIZED (
    SELECT candidate.token_digest
    FROM app_private.auth_sessions AS candidate
    WHERE candidate.expires_at <= effective_now
    ORDER BY candidate.expires_at, candidate.token_digest
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app_private.auth_sessions AS stored
  USING expired
  WHERE stored.token_digest = expired.token_digest;
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END;
$$;

REVOKE ALL ON FUNCTION app_private.purge_expired_auth_sessions(timestamptz, integer)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.purge_expired_auth_sessions(timestamptz, integer)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.purge_expired_auth_sessions(timestamptz, integer) IS
  'Maintenance only. Deletes at most batch_limit (1..1000) sessions that expired at or before effective_now (one materialized batch, earliest expiry then digest, skipping rows other transactions hold) and returns how many. Never touches a live session.';
