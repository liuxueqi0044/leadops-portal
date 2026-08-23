-- ============================================================================
-- 0003_repair_rls_policies.sql — Fix INSERT ... RETURNING RLS interaction.
--
-- PostgreSQL applies SELECT/INSERT policies' USING clauses to RETURNING rows
-- even for INSERT commands. During createOrganization the creator isn't yet
-- an active member, so app_is_active_member(id) fails. This migration adds a
-- permissive SELECT policy for rows whose id matches the context org_id,
-- allowing RETURNING to succeed without weakening multi-tenant isolation.
-- ============================================================================

-- organizations: add a SELECT policy for context-org-matching rows so that
-- CREATE ... RETURNING works during organization creation.
DROP POLICY IF EXISTS organizations_ctx_select ON organizations;
CREATE POLICY organizations_ctx_select ON organizations FOR SELECT
  USING (app_ctx_valid() AND id = app_org_id());

-- invitations: same for inviteOrganizationMember (uses RETURNING).
DROP POLICY IF EXISTS invitations_ctx_select ON invitations;
CREATE POLICY invitations_ctx_select ON invitations FOR SELECT
  USING (app_ctx_valid() AND "organizationId" = app_org_id());

-- Also ensure the existing policies don't have stale versions.
DROP POLICY IF EXISTS organizations_select ON organizations;
DROP POLICY IF EXISTS organizations_insert ON organizations;
DROP POLICY IF EXISTS organizations_update ON organizations;

CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (app_is_active_member(id));
CREATE POLICY organizations_insert ON organizations FOR INSERT
  WITH CHECK (
    app_ctx_valid()
    AND id = app_org_id()
    AND app_role() = 'agency_owner'
  );
CREATE POLICY organizations_update ON organizations FOR UPDATE
  USING (app_can_manage_members(id));

DROP POLICY IF EXISTS invitations_select ON invitations;
DROP POLICY IF EXISTS invitations_insert ON invitations;
DROP POLICY IF EXISTS invitations_update ON invitations;

CREATE POLICY invitations_select ON invitations FOR SELECT
  USING (app_is_active_member("organizationId") OR app_invitation_token_hash() = "tokenHash");
CREATE POLICY invitations_insert ON invitations FOR INSERT
  WITH CHECK (app_ctx_valid() AND "organizationId" = app_org_id());
CREATE POLICY invitations_update ON invitations FOR UPDATE
  USING (
    app_can_manage_members("organizationId")
    OR (app_invitation_token_hash() = "tokenHash" AND status = 'pending' AND "expiresAt" > now())
  );
