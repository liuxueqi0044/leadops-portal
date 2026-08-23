-- ============================================================================
-- 0002_harden_platform_rls.sql — platform_admin RLS gate
--
-- Defense in depth: acting as platform_admin inside tenant policies now
-- requires the server-side users.platform_admin flag (which runtime roles
-- cannot write) in addition to the context role. A forged
-- app.role='platform_admin' context alone grants nothing beyond the user's
-- active membership.
-- ============================================================================

-- True when the context user carries the server-side platform_admin flag and
-- is an active member of p_org.
CREATE OR REPLACE FUNCTION app_is_elevated_platform(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_role() = 'platform_admin'
     AND app_is_active_member(p_org)
     AND EXISTS (
       SELECT 1 FROM users u WHERE u.id = app_user_id() AND u.platform_admin
     )
$$;

-- Member-management capability (org-level): agency_owner, agency_admin or an
-- elevated (flag-verified) platform_admin of the context organization.
CREATE OR REPLACE FUNCTION app_can_manage_members(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_active_member(p_org)
     AND (
       app_role() IN ('agency_owner', 'agency_admin')
       OR app_is_elevated_platform(p_org)
     )
$$;

CREATE OR REPLACE FUNCTION app_can_manage_clients(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_active_member(p_org)
     AND (
       app_role() IN ('agency_owner', 'agency_admin')
       OR app_is_elevated_platform(p_org)
     )
$$;

CREATE OR REPLACE FUNCTION app_can_manage_client_members(p_client uuid, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_active_member(p_org)
     AND (
       app_role() IN ('agency_owner', 'agency_admin')
       OR app_is_elevated_platform(p_org)
       OR EXISTS (
         SELECT 1 FROM client_members m
         WHERE m."clientId" = p_client
           AND m."userId" = app_user_id()
           AND m.role = 'client_admin'
       )
     )
$$;

-- clients_select must grant client-wide visibility only to owner/admin or a
-- flag-verified elevated platform admin.
DROP POLICY IF EXISTS clients_select ON clients;
CREATE POLICY clients_select ON clients FOR SELECT
  USING (
    app_is_active_member("organizationId")
    AND (
      app_role() IN ('agency_owner', 'agency_admin')
      OR app_is_elevated_platform("organizationId")
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
