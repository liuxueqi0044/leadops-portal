-- ============================================================================
-- 0001_identity_tenancy.sql — Phase 2: identity, organizations, tenancy, RLS
--
-- Owner (migration runner) applies this file. Runtime application role
-- (leadops_runtime) and test runtime role (leadops_runtime_test) receive
-- identical grants through app_grant_runtime(). Neither owns any table,
-- neither is superuser, neither has BYPASSRLS.
-- All tenant tables are FORCE ROW LEVEL SECURITY. Context is provided by
-- parameterized set_config('app.*', ..., true) inside withTenantContext(),
-- which is transaction-local and cannot leak across pooled connections.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Database roles (cluster-wide, idempotent). PostgreSQL has no
--    CREATE ROLE IF NOT EXISTS, hence the DO blocks.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadops_runtime') THEN
    CREATE ROLE leadops_runtime LOGIN PASSWORD 'leadops_runtime_dev'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadops_runtime_test') THEN
    CREATE ROLE leadops_runtime_test LOGIN PASSWORD 'leadops_runtime_test_dev'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 2. Tables (identifiers quoted; camelCase matches Better Auth defaults)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  email varchar(320) NOT NULL,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image varchar(2048),
  platform_admin boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug varchar(64) NOT NULL CHECK (length(slug) BETWEEN 1 AND 64),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_unique ON organizations (slug);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token varchar(255) NOT NULL,
  "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  "ipAddress" varchar(64),
  "userAgent" varchar(1024),
  active_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_unique ON sessions (token);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions ("userId");

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "accountId" varchar(255) NOT NULL,
  "providerId" varchar(64) NOT NULL,
  "accessToken" varchar(2048),
  "refreshToken" varchar(2048),
  "idToken" varchar(4096),
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope varchar(1024),
  password varchar(4096),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_account_unique ON accounts ("providerId", "accountId");

CREATE TABLE IF NOT EXISTS verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier varchar(320) NOT NULL,
  value varchar(4096) NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verifications_identifier_idx ON verifications (identifier);

CREATE TABLE IF NOT EXISTS organization_members (
  "organizationId" uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(32) NOT NULL CHECK (role IN (
    'platform_admin', 'agency_owner', 'agency_admin', 'agency_operator',
    'client_admin', 'client_viewer'
  )),
  active boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organizationId", "userId")
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_members_user_org_unique
  ON organization_members ("userId", "organizationId");
CREATE INDEX IF NOT EXISTS organization_members_user_id_idx ON organization_members ("userId");

CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email varchar(320) NOT NULL,
  role varchar(32) NOT NULL CHECK (role IN (
    'agency_owner', 'agency_admin', 'agency_operator', 'client_admin', 'client_viewer'
  )),
  "tokenHash" varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'accepted', 'revoked', 'expired'
  )),
  "expiresAt" timestamptz NOT NULL,
  "invitedBy" uuid NOT NULL REFERENCES users(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_unique ON invitations ("tokenHash");
CREATE INDEX IF NOT EXISTS invitations_organization_id_idx ON invitations ("organizationId");
-- At most one pending invitation per (organization, normalized email).
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_org_email_unique
  ON invitations ("organizationId", lower(email)) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clients_organization_id_created_at_idx
  ON clients ("organizationId", "createdAt");
-- Backing unique index for composite (clientId, organizationId) FKs.
CREATE UNIQUE INDEX IF NOT EXISTS clients_id_organization_unique ON clients (id, "organizationId");

CREATE TABLE IF NOT EXISTS client_members (
  "clientId" uuid NOT NULL,
  "organizationId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  role varchar(32) NOT NULL CHECK (role IN ('client_admin', 'client_viewer')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("clientId", "userId"),
  CONSTRAINT client_members_client_org_fk
    FOREIGN KEY ("clientId", "organizationId") REFERENCES clients (id, "organizationId") ON DELETE CASCADE,
  CONSTRAINT client_members_user_org_fk
    FOREIGN KEY ("userId", "organizationId") REFERENCES organization_members ("userId", "organizationId") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS client_members_user_id_idx ON client_members ("userId");

CREATE TABLE IF NOT EXISTS client_assignments (
  "clientId" uuid NOT NULL,
  "organizationId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("clientId", "userId"),
  CONSTRAINT client_assignments_client_org_fk
    FOREIGN KEY ("clientId", "organizationId") REFERENCES clients (id, "organizationId") ON DELETE CASCADE,
  CONSTRAINT client_assignments_user_org_fk
    FOREIGN KEY ("userId", "organizationId") REFERENCES organization_members ("userId", "organizationId") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS client_assignments_user_id_idx ON client_assignments ("userId");

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "actorUserId" uuid REFERENCES users(id) ON DELETE SET NULL,
  action varchar(128) NOT NULL,
  "resourceType" varchar(64) NOT NULL,
  "resourceId" uuid,
  "clientId" uuid REFERENCES clients(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_organization_id_created_at_idx
  ON audit_logs ("organizationId", "createdAt");

-- ----------------------------------------------------------------------------
-- 3. RLS context helper functions (SECURITY INVOKER by default)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_role() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.role', true), '')
$$;

CREATE OR REPLACE FUNCTION app_client_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.client_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_invitation_token_hash() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.invitation_token_hash', true), '')
$$;

-- A valid tenant context requires user, organization and role to be set.
-- This is not a membership check: elevation and invitation-accept contexts
-- are valid contexts even before (or without) the user being an active member.
CREATE OR REPLACE FUNCTION app_ctx_valid() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app_user_id() IS NOT NULL
     AND app_org_id() IS NOT NULL
     AND app_role() IS NOT NULL
$$;

-- True when the context user is an ACTIVE member of p_org. Reads
-- organization_members; the RLS policy on organization_members is
-- context-based (no subqueries), so this does not recurse.
CREATE OR REPLACE FUNCTION app_is_active_member(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_ctx_valid()
     AND app_org_id() = p_org
     AND EXISTS (
       SELECT 1 FROM organization_members m
       WHERE m."organizationId" = p_org
         AND m."userId" = app_user_id()
         AND m.active
     )
$$;

-- Member-management capability (org-level): agency_owner, agency_admin or
-- elevated platform_admin of the context organization.
CREATE OR REPLACE FUNCTION app_can_manage_members(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_active_member(p_org)
     AND app_role() IN ('agency_owner', 'agency_admin', 'platform_admin')
$$;

-- Client-management capability (org-level): same roles as members above.
CREATE OR REPLACE FUNCTION app_can_manage_clients(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_active_member(p_org)
     AND app_role() IN ('agency_owner', 'agency_admin', 'platform_admin')
$$;

-- Client-member management capability: org-level roles OR client_admin of the
-- target client (scope is enforced by the clientId argument).
CREATE OR REPLACE FUNCTION app_can_manage_client_members(p_client uuid, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_active_member(p_org)
     AND (
       app_role() IN ('agency_owner', 'agency_admin', 'platform_admin')
       OR EXISTS (
         SELECT 1 FROM client_members m
         WHERE m."clientId" = p_client
           AND m."userId" = app_user_id()
           AND m.role = 'client_admin'
       )
     )
$$;

-- Invitation acceptance capability: the context user may insert their own
-- membership when a matching pending, unexpired invitation exists and the
-- context invitation token hash equals the invitation's stored hash.
CREATE OR REPLACE FUNCTION app_can_accept_invitation(p_org uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_ctx_valid()
     AND app_user_id() = p_user
     AND EXISTS (
       SELECT 1 FROM invitations i
       WHERE i."organizationId" = p_org
         AND i.status = 'pending'
         AND i."expiresAt" > now()
         AND i."tokenHash" = app_invitation_token_hash()
         AND i.email = (SELECT lower(u.email) FROM users u WHERE u.id = p_user)
     )
$$;

-- ----------------------------------------------------------------------------
-- 4. RLS enable + force + policies
-- ----------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (app_is_active_member(id));
-- Organization creation is the only path that sets a context organization id
-- which does not yet exist (createOrganization generates the id first and
-- opens the transaction context on it). The id must equal the context org.
CREATE POLICY organizations_insert ON organizations FOR INSERT
  WITH CHECK (
    app_ctx_valid()
    AND id = app_org_id()
    AND app_role() = 'agency_owner'
  );
CREATE POLICY organizations_update ON organizations FOR UPDATE
  USING (app_can_manage_members(id));

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_members_select ON organization_members FOR SELECT
  USING (app_ctx_valid() AND "organizationId" = app_org_id());
CREATE POLICY organization_members_insert ON organization_members FOR INSERT
  WITH CHECK (
    app_can_manage_members("organizationId")
    OR app_can_accept_invitation("organizationId", "userId")
    -- Creator self-insert during createOrganization: context role is
    -- agency_owner and the target organization is the just-created context
    -- organization, before any membership exists.
    OR (
      app_ctx_valid()
      AND "userId" = app_user_id()
      AND "organizationId" = app_org_id()
      AND "role" = 'agency_owner'
      AND app_role() = 'agency_owner'
    )
  );
CREATE POLICY organization_members_update ON organization_members FOR UPDATE
  USING (app_can_manage_members("organizationId"));
CREATE POLICY organization_members_delete ON organization_members FOR DELETE
  USING (app_can_manage_members("organizationId"));

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY invitations_select ON invitations FOR SELECT
  USING (app_is_active_member("organizationId") OR app_invitation_token_hash() = "tokenHash");
CREATE POLICY invitations_insert ON invitations FOR INSERT
  WITH CHECK (app_can_manage_members("organizationId"));
CREATE POLICY invitations_update ON invitations FOR UPDATE
  USING (
    app_can_manage_members("organizationId")
    OR (app_invitation_token_hash() = "tokenHash" AND status = 'pending' AND "expiresAt" > now())
  );

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;

CREATE POLICY clients_select ON clients FOR SELECT
  USING (
    app_is_active_member("organizationId")
    AND (
      app_role() IN ('agency_owner', 'agency_admin', 'platform_admin')
      OR EXISTS (
        SELECT 1 FROM client_assignments a
        WHERE a."clientId" = clients.id AND a."userId" = app_user_id()
      )
      OR EXISTS (
        SELECT 1 FROM client_members m
        WHERE m."clientId" = clients.id AND m."userId" = app_user_id()
      )
    )
  );
CREATE POLICY clients_insert ON clients FOR INSERT
  WITH CHECK (app_can_manage_clients("organizationId"));
CREATE POLICY clients_update ON clients FOR UPDATE
  USING (app_can_manage_clients("organizationId"));

ALTER TABLE client_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_members FORCE ROW LEVEL SECURITY;

CREATE POLICY client_members_select ON client_members FOR SELECT
  USING (app_ctx_valid() AND "organizationId" = app_org_id());
CREATE POLICY client_members_insert ON client_members FOR INSERT
  WITH CHECK (app_can_manage_client_members("clientId", "organizationId"));
CREATE POLICY client_members_update ON client_members FOR UPDATE
  USING (app_can_manage_client_members("clientId", "organizationId"));
CREATE POLICY client_members_delete ON client_members FOR DELETE
  USING (app_can_manage_client_members("clientId", "organizationId"));

ALTER TABLE client_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY client_assignments_select ON client_assignments FOR SELECT
  USING (app_ctx_valid() AND "organizationId" = app_org_id());
CREATE POLICY client_assignments_insert ON client_assignments FOR INSERT
  WITH CHECK (app_can_manage_clients("organizationId"));
CREATE POLICY client_assignments_delete ON client_assignments FOR DELETE
  USING (app_can_manage_clients("organizationId"));

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_select ON audit_logs FOR SELECT
  USING (app_is_active_member("organizationId"));
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT
  WITH CHECK (app_ctx_valid() AND "organizationId" = app_org_id());

-- ----------------------------------------------------------------------------
-- 5. Grants to runtime roles (identical privilege sets, single source of truth)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_grant_runtime(_role text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), _role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', _role);

  -- Auth tables (Better Auth lifecycle; not tenant-scoped, no RLS).
  EXECUTE format('GRANT SELECT, INSERT ON users TO %I', _role);
  EXECUTE format('GRANT UPDATE (name, email, "emailVerified", image, "updatedAt") ON users TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON accounts TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON verifications TO %I', _role);

  -- Tenant tables: privileges granted, row-level access decided by RLS.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON organizations TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON organization_members TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON invitations TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON clients TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON client_members TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, DELETE ON client_assignments TO %I', _role);
  -- audit_logs is append-only for runtime roles: no UPDATE, no DELETE, ever.
  EXECUTE format('GRANT SELECT, INSERT ON audit_logs TO %I', _role);

  -- Column-level: platform_admin flag is server-owned; runtime roles cannot
  -- set it even though they hold INSERT on users.
  EXECUTE format('REVOKE UPDATE ("platform_admin") ON users FROM %I', _role);
END
$$;

SELECT app_grant_runtime('leadops_runtime');
SELECT app_grant_runtime('leadops_runtime_test');

REVOKE EXECUTE ON FUNCTION app_grant_runtime(text) FROM PUBLIC;
