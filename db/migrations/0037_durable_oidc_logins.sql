-- ADR-0081: a pending OpenID Connect login survives an ordinary API restart and can complete on another API instance
-- that uses the same database and the same OIDC configuration.
--
-- One row per sign-in that has been sent to the identity provider and has not come back yet. The browser holds an
-- opaque login identifier in a short-lived HttpOnly cookie; this table holds only its SHA-256 digest (base64url, 43
-- characters), never the identifier. A row is first a reservation (no material: capacity is taken before provider
-- discovery), then completed with what the callback needs: the PKCE code verifier, the state and the nonce. These are
-- useless without the authorization code the provider sends back to the browser and the client secret the exchange
-- requires. Nothing about the person, the device or the provider's tokens is stored.
--
-- Lifetime: absolute from the reservation instant (OIDC_LOGIN_TTL_MS, at most one hour, also a table constraint).
-- Completing a reservation never extends it, and an attempt is single use: the callback deletes it before any provider
-- work, whatever happens next.
--
-- Privileges: no application role has any privilege on the table. The runtime role reaches it only through four
-- SECURITY DEFINER functions that take a digest it already knows (reserve, complete, consume, cancel): it cannot list
-- pending logins, read one without its identifier, or count them. The maintenance role can only purge expired rows in
-- bounded batches. Clearing every pending login after a restore is granted to nobody: the owner runs it while the
-- restored database is still closed to the application.
--
-- Backups: application backups dump the table's schema without its rows (pg_dump --exclude-table-data), and the
-- restore procedure clears it again before the database is reopened, so no pre-restore sign-in can complete.
CREATE TABLE app_private.oidc_pending_logins (
  login_digest text PRIMARY KEY,
  created_at timestamp(3) with time zone NOT NULL,
  expires_at timestamp(3) with time zone NOT NULL,
  code_verifier text,
  oidc_state text,
  oidc_nonce text,
  CONSTRAINT oidc_pending_logins_digest_shape CHECK (login_digest ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT oidc_pending_logins_instants_finite CHECK (isfinite(created_at) AND isfinite(expires_at)),
  -- OIDC_LOGIN_TTL_MS is at most one hour; a row can never outlive that from its reservation instant.
  CONSTRAINT oidc_pending_logins_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  -- A reservation has no material; a completed attempt has all three.
  CONSTRAINT oidc_pending_logins_material_together CHECK (
    (code_verifier IS NULL AND oidc_state IS NULL AND oidc_nonce IS NULL)
    OR (code_verifier IS NOT NULL AND oidc_state IS NOT NULL AND oidc_nonce IS NOT NULL)
  ),
  -- Bounded, URL-safe values (RFC 3986 unreserved characters), the shape the OIDC client generates.
  CONSTRAINT oidc_pending_logins_verifier_shape CHECK (code_verifier ~ '^[A-Za-z0-9._~-]{1,255}$'),
  CONSTRAINT oidc_pending_logins_state_shape CHECK (oidc_state ~ '^[A-Za-z0-9._~-]{1,255}$'),
  CONSTRAINT oidc_pending_logins_nonce_shape CHECK (oidc_nonce ~ '^[A-Za-z0-9._~-]{1,255}$')
);

CREATE INDEX oidc_pending_logins_expires_at_idx ON app_private.oidc_pending_logins (expires_at);

COMMENT ON TABLE app_private.oidc_pending_logins IS
  'Pending OpenID Connect logins (ADR-0081). Login identifier digest, reservation and expiry instants, and once completed the PKCE verifier, state and nonce the callback needs. No application role has table privileges; access is through app_private.reserve_oidc_login, complete_oidc_login, consume_oidc_login, cancel_oidc_login (runtime), purge_expired_oidc_logins (maintenance) and clear_oidc_pending_logins (owner only, at restore). Rows are excluded from application backups.';

-- Defence in depth: even a future accidental grant shows no row without a policy.
ALTER TABLE app_private.oidc_pending_logins ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE app_private.oidc_pending_logins FROM PUBLIC;
REVOKE ALL ON TABLE app_private.oidc_pending_logins FROM running_tracker_runtime;
REVOKE ALL ON TABLE app_private.oidc_pending_logins FROM running_tracker_maintenance;

-- 1. Reserve room for one login before the provider is contacted.
--
-- Every reservation takes the same transaction-scoped advisory lock, so concurrent sign-ins on any number of API
-- instances are counted one after another and cannot overshoot the capacity together. Under the lock: the browser's
-- own previous attempt (the digest of the login cookie it presented, if any) is removed, then at most 100 rows already
-- expired at the reservation instant, then the live rows are counted, reservations and completed attempts alike. A
-- store full of live attempts refuses the new one; no other live attempt is ever evicted. An existing digest is never
-- replaced.
--
-- Outcomes: reserved, at_capacity, duplicate (digest already present).
CREATE FUNCTION app_private.reserve_oidc_login(
  requested_digest text,
  reserved_at timestamptz,
  reserved_until timestamptz,
  store_capacity integer,
  replaced_digest text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  live_logins integer;
BEGIN
  -- Not STRICT: replaced_digest is optional, and every other argument must be present.
  IF requested_digest IS NULL OR reserved_at IS NULL OR reserved_until IS NULL OR store_capacity IS NULL THEN
    RAISE EXCEPTION 'pending login reservation arguments must not be null' USING ERRCODE = '22004';
  END IF;
  IF store_capacity < 1 OR store_capacity > 10000 THEN
    RAISE EXCEPTION 'pending login capacity must be between 1 and 10000: %', store_capacity
      USING ERRCODE = '22023';
  END IF;
  IF NOT isfinite(reserved_at) OR NOT isfinite(reserved_until) THEN
    RAISE EXCEPTION 'pending login instants must be finite' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('running-tracker:oidc-login-capacity', 0)
  );

  IF replaced_digest IS NOT NULL THEN
    DELETE FROM app_private.oidc_pending_logins AS previous
    WHERE previous.login_digest = replaced_digest;
  END IF;

  -- The batch is chosen once (MATERIALIZED), then deleted by join. A LIMIT inside `WHERE ... IN (subquery)` is not a
  -- bound: a plan that rescans the subquery skips the rows this statement already deleted and returns new ones.
  WITH expired AS MATERIALIZED (
    SELECT candidate.login_digest
    FROM app_private.oidc_pending_logins AS candidate
    WHERE candidate.expires_at <= reserved_at
    ORDER BY candidate.expires_at, candidate.login_digest
    LIMIT 100
  )
  DELETE FROM app_private.oidc_pending_logins AS stored
  USING expired
  WHERE stored.login_digest = expired.login_digest;

  SELECT count(*)::integer
  INTO live_logins
  FROM app_private.oidc_pending_logins AS stored
  WHERE stored.expires_at > reserved_at;

  IF live_logins >= store_capacity THEN
    RETURN 'at_capacity';
  END IF;

  INSERT INTO app_private.oidc_pending_logins (login_digest, created_at, expires_at)
  VALUES (requested_digest, reserved_at, reserved_until)
  ON CONFLICT (login_digest) DO NOTHING;
  IF NOT FOUND THEN
    RETURN 'duplicate';
  END IF;

  RETURN 'reserved';
END;
$$;

REVOKE ALL ON FUNCTION app_private.reserve_oidc_login(text, timestamptz, timestamptz, integer, text)
  FROM PUBLIC, running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.reserve_oidc_login(text, timestamptz, timestamptz, integer, text)
  TO running_tracker_runtime;

COMMENT ON FUNCTION app_private.reserve_oidc_login(text, timestamptz, timestamptz, integer, text) IS
  'Runtime only. Removes the caller''s own previous attempt (by digest) and at most 100 expired rows, then reserves one attempt when fewer than store_capacity attempts (reserved or completed) are live at reserved_at. Serialized by an advisory transaction lock. Never replaces an existing digest and never evicts another live attempt. Returns reserved, at_capacity or duplicate.';

-- 2. Complete a reservation with the material the callback needs. Only a live reservation that has not been completed
-- yet is changed; its expiry is left as it was.
CREATE FUNCTION app_private.complete_oidc_login(
  requested_digest text,
  pkce_code_verifier text,
  expected_state text,
  expected_nonce text,
  effective_now timestamptz
)
RETURNS boolean
LANGUAGE sql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH completed AS (
    UPDATE app_private.oidc_pending_logins AS pending
    SET code_verifier = pkce_code_verifier, oidc_state = expected_state, oidc_nonce = expected_nonce
    WHERE pending.login_digest = requested_digest
      AND pending.code_verifier IS NULL
      AND pending.expires_at > effective_now
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM completed)
$$;

REVOKE ALL ON FUNCTION app_private.complete_oidc_login(text, text, text, text, timestamptz)
  FROM PUBLIC, running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.complete_oidc_login(text, text, text, text, timestamptz)
  TO running_tracker_runtime;

COMMENT ON FUNCTION app_private.complete_oidc_login(text, text, text, text, timestamptz) IS
  'Runtime only. Stores the PKCE verifier, state and nonce on the reservation under exactly this digest if it is live at effective_now and not completed yet; never extends its expiry and never overwrites a completed or consumed attempt. Returns whether it did.';

-- 3. Consume an attempt: delete it and return its material only if it was completed and is live at the caller's
-- instant. The row is removed whatever its state, so an attempt is single use. Two concurrent consumers of one digest
-- cannot both receive it: the DELETE locks the row, and the second one finds it gone.
CREATE FUNCTION app_private.consume_oidc_login(requested_digest text, effective_now timestamptz)
RETURNS TABLE (code_verifier text, oidc_state text, oidc_nonce text)
LANGUAGE sql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH removed AS (
    DELETE FROM app_private.oidc_pending_logins AS pending
    WHERE pending.login_digest = requested_digest
    RETURNING pending.code_verifier, pending.oidc_state, pending.oidc_nonce, pending.expires_at
  )
  SELECT removed.code_verifier, removed.oidc_state, removed.oidc_nonce
  FROM removed
  WHERE removed.code_verifier IS NOT NULL
    AND removed.expires_at > effective_now
$$;

REVOKE ALL ON FUNCTION app_private.consume_oidc_login(text, timestamptz) FROM PUBLIC, running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.consume_oidc_login(text, timestamptz) TO running_tracker_runtime;

COMMENT ON FUNCTION app_private.consume_oidc_login(text, timestamptz) IS
  'Runtime only. Deletes the attempt stored under exactly this digest and returns its verifier, state and nonce only if it was completed and expires after effective_now. At most one caller ever receives an attempt.';

-- 4. Cancel an attempt the caller started (a failed or abandoned sign-in). Returns whether a row was removed.
CREATE FUNCTION app_private.cancel_oidc_login(requested_digest text)
RETURNS boolean
LANGUAGE sql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH removed AS (
    DELETE FROM app_private.oidc_pending_logins AS pending
    WHERE pending.login_digest = requested_digest
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM removed)
$$;

REVOKE ALL ON FUNCTION app_private.cancel_oidc_login(text) FROM PUBLIC, running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.cancel_oidc_login(text) TO running_tracker_runtime;

COMMENT ON FUNCTION app_private.cancel_oidc_login(text) IS
  'Runtime only. Deletes the attempt stored under exactly this digest and returns whether one existed.';

-- 5. Bounded purge of expired attempts (maintenance).
CREATE FUNCTION app_private.purge_expired_oidc_logins(effective_now timestamptz, batch_limit integer)
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
    RAISE EXCEPTION 'pending login purge batch limit must be between 1 and 1000: %', batch_limit
      USING ERRCODE = '22023';
  END IF;
  IF NOT isfinite(effective_now) THEN
    RAISE EXCEPTION 'effective_now must be finite' USING ERRCODE = '22023';
  END IF;

  -- Chosen once, then deleted by join, so batch_limit is a real bound whatever the plan (see reserve_oidc_login).
  WITH expired AS MATERIALIZED (
    SELECT candidate.login_digest
    FROM app_private.oidc_pending_logins AS candidate
    WHERE candidate.expires_at <= effective_now
    ORDER BY candidate.expires_at, candidate.login_digest
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app_private.oidc_pending_logins AS stored
  USING expired
  WHERE stored.login_digest = expired.login_digest;
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END;
$$;

REVOKE ALL ON FUNCTION app_private.purge_expired_oidc_logins(timestamptz, integer)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.purge_expired_oidc_logins(timestamptz, integer)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.purge_expired_oidc_logins(timestamptz, integer) IS
  'Maintenance only. Deletes at most batch_limit (1..1000) pending logins that expired at or before effective_now and returns how many. Never touches a live attempt.';

-- 6. Restore: remove every pending login. Granted to nobody, so only the owner (the migration role) or a superuser
-- runs it, against a restored database that is not yet open to the application.
CREATE FUNCTION app_private.clear_oidc_pending_logins()
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  cleared bigint;
BEGIN
  DELETE FROM app_private.oidc_pending_logins;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END;
$$;

REVOKE ALL ON FUNCTION app_private.clear_oidc_pending_logins()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

COMMENT ON FUNCTION app_private.clear_oidc_pending_logins() IS
  'Restore-time only, owner only. Deletes every pending login so that no sign-in started before the restore can complete afterwards, including attempts a dump brought back; people start a new sign-in. Returns the number removed.';
