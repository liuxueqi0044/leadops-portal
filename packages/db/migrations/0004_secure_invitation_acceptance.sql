-- ============================================================================
-- 0004_secure_invitation_acceptance.sql
--
-- An invitee reads a pending invitation through the token-scoped SELECT
-- policy, then changes only its status to accepted. PostgreSQL applies an
-- UPDATE policy's WITH CHECK expression to the new row. Reusing the old-row
-- `status = 'pending'` predicate implicitly therefore rejected the legitimate
-- pending -> accepted transition.
--
-- Keep the old-row and new-row rules explicit, bind token acceptance to the
-- matching signed-in user's email, and limit runtime UPDATE privileges to the
-- two columns the invitation lifecycle actually changes.
-- ============================================================================

DROP POLICY IF EXISTS invitations_update ON invitations;
CREATE POLICY invitations_update ON invitations FOR UPDATE
  USING (
    app_can_manage_members("organizationId")
    OR (
      app_ctx_valid()
      AND "organizationId" = app_org_id()
      AND app_invitation_token_hash() = "tokenHash"
      AND status = 'pending'
      AND "expiresAt" > now()
      AND EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = app_user_id()
          AND lower(u.email) = lower(invitations.email)
      )
    )
  )
  WITH CHECK (
    app_can_manage_members("organizationId")
    OR (
      app_ctx_valid()
      AND "organizationId" = app_org_id()
      AND app_invitation_token_hash() = "tokenHash"
      AND status = 'accepted'
      AND "expiresAt" > now()
      AND EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = app_user_id()
          AND lower(u.email) = lower(invitations.email)
      )
    )
  );

-- Keep app_grant_runtime as the single privilege source for both existing and
-- future runtime roles. A table-level UPDATE grant would let a token holder
-- try to alter role/email/org/token fields through direct SQL.
CREATE OR REPLACE FUNCTION app_grant_runtime(_role text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), _role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', _role);

  EXECUTE format('GRANT SELECT, INSERT ON users TO %I', _role);
  EXECUTE format('GRANT UPDATE (name, email, "emailVerified", image, "updatedAt") ON users TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON accounts TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON verifications TO %I', _role);

  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON organizations TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON organization_members TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON invitations TO %I', _role);
  EXECUTE format('REVOKE UPDATE ON invitations FROM %I', _role);
  EXECUTE format('GRANT UPDATE (status, "updatedAt") ON invitations TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON clients TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON client_members TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, DELETE ON client_assignments TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON audit_logs TO %I', _role);

  EXECUTE format('REVOKE UPDATE ("platform_admin") ON users FROM %I', _role);
END
$$;

SELECT app_grant_runtime('leadops_runtime');
SELECT app_grant_runtime('leadops_runtime_test');
REVOKE EXECUTE ON FUNCTION app_grant_runtime(text) FROM PUBLIC;
