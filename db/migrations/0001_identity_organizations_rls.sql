CREATE SCHEMA app_private AUTHORIZATION running_tracker_owner;

REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private TO running_tracker_runtime;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  external_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_external_identity_not_blank CHECK (btrim(external_identity) <> ''),
  CONSTRAINT users_external_identity_unique UNIQUE (external_identity)
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  archive_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_archive_revision_nonnegative CHECK (archive_revision >= 0)
);

CREATE TABLE memberships (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  CONSTRAINT memberships_organization_fk
    FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
  CONSTRAINT memberships_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT memberships_role_known CHECK (role IN ('runner', 'coach'))
);

CREATE INDEX memberships_active_user_organizations_idx
  ON memberships (user_id, org_id)
  WHERE active;

CREATE FUNCTION app_private.current_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  configured_value text;
BEGIN
  configured_value := current_setting('app.user_id', true);
  IF configured_value IS NULL OR configured_value = '' THEN
    RETURN NULL;
  END IF;
  RETURN configured_value::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

CREATE FUNCTION app_private.current_org_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  configured_value text;
BEGIN
  configured_value := current_setting('app.org_id', true);
  IF configured_value IS NULL OR configured_value = '' THEN
    RETURN NULL;
  END IF;
  RETURN configured_value::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

CREATE FUNCTION app_private.has_active_membership()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships AS membership
    WHERE membership.org_id = app_private.current_org_id()
      AND membership.user_id = app_private.current_user_id()
      AND membership.active
  )
$$;

REVOKE ALL ON FUNCTION app_private.current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.current_org_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.has_active_membership() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.current_user_id() TO running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.current_org_id() TO running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.has_active_membership() TO running_tracker_runtime;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select_current_identity
ON users
FOR SELECT
TO running_tracker_runtime
USING (
  id = app_private.current_user_id()
  AND app_private.has_active_membership()
);

CREATE POLICY organizations_select_current_tenant
ON organizations
FOR SELECT
TO running_tracker_runtime
USING (
  id = app_private.current_org_id()
  AND app_private.has_active_membership()
);

CREATE POLICY memberships_select_current_active_membership
ON memberships
FOR SELECT
TO running_tracker_runtime
USING (
  org_id = app_private.current_org_id()
  AND user_id = app_private.current_user_id()
  AND active
  AND app_private.has_active_membership()
);

REVOKE ALL ON TABLE users, organizations, memberships FROM PUBLIC;
REVOKE ALL ON TABLE users, organizations, memberships FROM running_tracker_runtime;
REVOKE ALL ON TABLE users, organizations, memberships FROM running_tracker_maintenance;
GRANT SELECT ON TABLE users, organizations, memberships TO running_tracker_runtime;

REVOKE ALL ON TABLE schema_migrations FROM running_tracker_runtime;
REVOKE ALL ON TABLE schema_migrations FROM running_tracker_maintenance;
