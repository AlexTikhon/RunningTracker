-- ADR-0080: authenticated sessions survive an ordinary API restart.
--
-- One row per signed-in browser session. The browser holds an opaque bearer token; this table holds only its
-- SHA-256 digest (base64url, 43 characters), never the token. The CSRF token is stored as issued because the current
-- protocol returns it from GET /api/session; it is useless without the session cookie. Nothing else about the person
-- or the device is kept.
--
-- Privileges: no application role has any privilege on the table. The runtime role reaches it only through three
-- SECURITY DEFINER functions that take a digest it already knows (create, read, revoke): it cannot list sessions,
-- count other people's sessions, or move an existing session to another identity. The maintenance role can only
-- purge expired rows in bounded batches. Clearing every session after a restore is granted to nobody: the owner runs
-- it while the restored database is still closed to the application.
--
-- Backups: application backups dump the table's schema without its rows (pg_dump --exclude-table-data), and the
-- restore procedure clears it again before the database is reopened, so a restored database never brings back a
-- session, revoked or not.
CREATE TABLE app_private.auth_sessions (
  token_digest text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  issued_at timestamp(3) with time zone NOT NULL,
  expires_at timestamp(3) with time zone NOT NULL,
  CONSTRAINT auth_sessions_token_digest_shape CHECK (token_digest ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT auth_sessions_csrf_token_shape CHECK (csrf_token ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT auth_sessions_instants_finite CHECK (isfinite(issued_at) AND isfinite(expires_at)),
  -- SESSION_TTL_MS is at most 24 hours; a row can never outlive that from its issue instant.
  CONSTRAINT auth_sessions_lifetime CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '24 hours')
);

CREATE INDEX auth_sessions_expires_at_idx ON app_private.auth_sessions (expires_at);
CREATE INDEX auth_sessions_user_id_idx ON app_private.auth_sessions (user_id);

COMMENT ON TABLE app_private.auth_sessions IS
  'Server-side authenticated sessions (ADR-0080). Token digest, user, CSRF token, issue and expiry instants only. No application role has table privileges; access is through app_private.create_auth_session, read_auth_session, revoke_auth_session (runtime), purge_expired_auth_sessions (maintenance) and clear_auth_sessions (owner only, at restore). Rows are excluded from application backups.';

-- Defence in depth: even a future accidental grant shows no row without a policy.
ALTER TABLE app_private.auth_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE app_private.auth_sessions FROM PUBLIC;
REVOKE ALL ON TABLE app_private.auth_sessions FROM running_tracker_runtime;
REVOKE ALL ON TABLE app_private.auth_sessions FROM running_tracker_maintenance;

-- 1. Create one session under the store's capacity.
--
-- Every creation takes the same transaction-scoped advisory lock, so concurrent sign-ins on any number of API
-- instances are counted one after another and cannot overshoot the capacity together. Under the lock: at most 100
-- rows already expired at the new session's issue instant are removed (bounded work per sign-in), then the live rows
-- are counted. A store full of live sessions refuses the new one; no live session is ever evicted (ADR-0075). An
-- existing digest is never replaced, so this function cannot move a session to another identity.
--
-- Outcomes: created, at_capacity, unknown_user (no such provisioned user), duplicate (digest already present).
CREATE FUNCTION app_private.create_auth_session(
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

  DELETE FROM app_private.auth_sessions AS stored
  WHERE stored.token_digest IN (
    SELECT expired.token_digest
    FROM app_private.auth_sessions AS expired
    WHERE expired.expires_at <= session_issued_at
    ORDER BY expired.expires_at
    LIMIT 100
  );

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
  'Runtime only. Inserts one session for a provisioned user when fewer than store_capacity sessions are live at its issue instant, after removing at most 100 expired rows. Serialized by an advisory transaction lock. Never replaces an existing digest and never evicts a live session. Returns created, at_capacity, unknown_user or duplicate.';

-- 2. Read one session by digest, only while it is live at the caller's instant.
CREATE FUNCTION app_private.read_auth_session(session_token_digest text, effective_now timestamptz)
RETURNS TABLE (user_id uuid, csrf_token text, issued_at timestamptz, expires_at timestamptz)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT stored.user_id, stored.csrf_token, stored.issued_at, stored.expires_at
  FROM app_private.auth_sessions AS stored
  WHERE stored.token_digest = session_token_digest
    AND stored.expires_at > effective_now
$$;

REVOKE ALL ON FUNCTION app_private.read_auth_session(text, timestamptz)
  FROM PUBLIC, running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.read_auth_session(text, timestamptz) TO running_tracker_runtime;

COMMENT ON FUNCTION app_private.read_auth_session(text, timestamptz) IS
  'Runtime only. Returns the session stored under exactly this digest if it expires after effective_now, otherwise no row. There is no way to list or count sessions.';

-- 3. Revoke one session by digest (sign-out). Returns whether a row was removed.
CREATE FUNCTION app_private.revoke_auth_session(session_token_digest text)
RETURNS boolean
LANGUAGE sql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH removed AS (
    DELETE FROM app_private.auth_sessions AS stored
    WHERE stored.token_digest = session_token_digest
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM removed)
$$;

REVOKE ALL ON FUNCTION app_private.revoke_auth_session(text) FROM PUBLIC, running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.revoke_auth_session(text) TO running_tracker_runtime;

COMMENT ON FUNCTION app_private.revoke_auth_session(text) IS
  'Runtime only. Deletes the session stored under exactly this digest and returns whether one existed.';

-- 4. Bounded purge of expired sessions (maintenance).
CREATE FUNCTION app_private.purge_expired_auth_sessions(effective_now timestamptz, batch_limit integer)
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

  DELETE FROM app_private.auth_sessions AS stored
  WHERE stored.token_digest IN (
    SELECT expired.token_digest
    FROM app_private.auth_sessions AS expired
    WHERE expired.expires_at <= effective_now
    ORDER BY expired.expires_at
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END;
$$;

REVOKE ALL ON FUNCTION app_private.purge_expired_auth_sessions(timestamptz, integer)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.purge_expired_auth_sessions(timestamptz, integer)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.purge_expired_auth_sessions(timestamptz, integer) IS
  'Maintenance only. Deletes at most batch_limit (1..1000) sessions that expired at or before effective_now and returns how many. Never touches a live session.';

-- 5. Restore: remove every session. Granted to nobody, so only the owner (the migration role) or a superuser runs it,
-- against a restored database that is not yet open to the application.
CREATE FUNCTION app_private.clear_auth_sessions()
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  cleared bigint;
BEGIN
  DELETE FROM app_private.auth_sessions;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END;
$$;

REVOKE ALL ON FUNCTION app_private.clear_auth_sessions()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

COMMENT ON FUNCTION app_private.clear_auth_sessions() IS
  'Restore-time only, owner only. Deletes every stored session so a restored database cannot authenticate any session cookie, revoked or not; everyone signs in again. Returns the number removed.';
