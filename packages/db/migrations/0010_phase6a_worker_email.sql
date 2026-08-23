-- 0010_phase6a_worker_email.sql — Phase 6A: Worker infrastructure and email delivery
--
-- email_deliveries      — outbound email delivery records with idempotency
-- SECURITY DEFINER      — claim, mark sent, mark failed (tenant-validated)
-- Worker grants         — additive to Phase 5 worker grants
-- ============================================================================

-- Existing queued jobs predate the registry contract. Backfill the version so
-- an in-place upgrade can drain them under strict payload validation.
UPDATE outbox
SET payload = jsonb_set(payload, '{schemaVersion}', '1'::jsonb, true)
WHERE message_type IN ('events.project', 'leads.qualify')
  AND NOT (payload ? 'schemaVersion');

-- ----------------------------------------------------------------------------
-- 1. email_deliveries table
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  "integrationId" uuid NOT NULL,
  template_name varchar(100) NOT NULL,
  to_email varchar(320) NOT NULL,
  subject text NOT NULL,
  html_body text NOT NULL,
  text_body text NOT NULL,
  idempotency_key text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'permanent_failure')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error text,
  provider_message_id text,
  "nextAttemptAt" timestamptz DEFAULT now(),
  "lockedAt" timestamptz,
  "lockedBy" varchar(200),
  "deliveredAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("clientId", "organizationId") REFERENCES clients(id, "organizationId"),
  FOREIGN KEY ("integrationId", "organizationId", "clientId")
    REFERENCES integrations(id, "organizationId", "clientId"),
  UNIQUE ("organizationId", "clientId", idempotency_key)
);

CREATE INDEX IF NOT EXISTS email_deliveries_status_idx
  ON email_deliveries (status, "nextAttemptAt" ASC NULLS FIRST)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS email_deliveries_idem_idx
  ON email_deliveries ("organizationId", "clientId", idempotency_key);

-- ----------------------------------------------------------------------------
-- 2. RLS policies — email_deliveries
-- ----------------------------------------------------------------------------
ALTER TABLE email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_deliveries_select ON email_deliveries;
CREATE POLICY email_deliveries_select ON email_deliveries FOR SELECT
  USING (
    (
      app_ctx_valid()
      AND app_user_can_access_client("organizationId", "clientId")
    )
    OR (
      "integrationId" IS NOT NULL
      AND app_machine_can_access("organizationId", "clientId", "integrationId")
    )
  );

DROP POLICY IF EXISTS email_deliveries_insert ON email_deliveries;
CREATE POLICY email_deliveries_insert ON email_deliveries FOR INSERT
  WITH CHECK (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

-- Worker update is handled via SECURITY DEFINER functions; direct
-- UPDATE by runtime roles is restricted to user context only.
DROP POLICY IF EXISTS email_deliveries_update ON email_deliveries;
CREATE POLICY email_deliveries_update ON email_deliveries FOR UPDATE
  USING (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

-- ----------------------------------------------------------------------------
-- 3. SECURITY DEFINER — claim single email delivery (tenant-validated)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_email_delivery(
  p_delivery_id uuid,
  p_org uuid,
  p_client uuid,
  p_integration_id uuid,
  p_worker_id text
) RETURNS SETOF email_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_row email_deliveries%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) = 0 THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;

  IF NOT app_machine_can_access(p_org, p_client, p_integration_id) THEN
    RAISE EXCEPTION 'email delivery context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  -- Read the row from the server to validate tenant binding — do not trust
  -- any of the caller-supplied p_org / p_client.
  SELECT * INTO v_row
  FROM email_deliveries e
  WHERE e.id = p_delivery_id
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Reject cross-tenant claim: the delivery must belong to the exact
  -- organization + client the caller presented.
  IF v_row."organizationId" IS DISTINCT FROM p_org
     OR v_row."clientId" IS DISTINCT FROM p_client
     OR v_row."integrationId" IS DISTINCT FROM p_integration_id THEN
    RAISE EXCEPTION 'email delivery tenant binding mismatch'
      USING ERRCODE = '42501';
  END IF;

  -- Claim only if eligible: pending with nextAttemptAt arrived, or stale processing lease.
  IF v_row.status = 'pending' THEN
    IF v_row."nextAttemptAt" IS NOT NULL AND v_row."nextAttemptAt" > now() THEN
      RETURN;
    END IF;
  ELSIF v_row.status = 'processing' THEN
    IF v_row."lockedAt" >= (now() - interval '5 minutes') THEN
      RETURN;
    END IF;
  ELSE
    RETURN;
  END IF;

  UPDATE email_deliveries
  SET status = 'processing',
      attempt_count = attempt_count + 1,
      "lockedAt" = now(),
      "lockedBy" = p_worker_id
  WHERE id = v_row.id;

  SELECT * INTO v_row
  FROM email_deliveries e
  WHERE e.id = p_delivery_id;

  RETURN NEXT v_row;
END
$$;

REVOKE EXECUTE ON FUNCTION claim_email_delivery(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_email_delivery(uuid, uuid, uuid, uuid, text) TO leadops_worker;
GRANT EXECUTE ON FUNCTION claim_email_delivery(uuid, uuid, uuid, uuid, text) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 4. SECURITY DEFINER — mark email delivery sent (tenant-validated)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_email_delivery_sent(
  p_delivery_id uuid,
  p_org uuid,
  p_client uuid,
  p_integration_id uuid,
  p_worker_id text,
  p_provider_message_id text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid;
  v_client uuid;
  v_integration_id uuid;
  rows_updated integer;
BEGIN
  IF NOT app_machine_can_access(p_org, p_client, p_integration_id) THEN
    RAISE EXCEPTION 'email delivery context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  SELECT e."organizationId", e."clientId", e."integrationId"
  INTO v_org, v_client, v_integration_id
  FROM email_deliveries e
  WHERE e.id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Server-side tenant validation.
  IF v_org IS DISTINCT FROM p_org OR v_client IS DISTINCT FROM p_client
     OR v_integration_id IS DISTINCT FROM p_integration_id THEN
    RAISE EXCEPTION 'email delivery tenant binding mismatch'
      USING ERRCODE = '42501';
  END IF;

  UPDATE email_deliveries
  SET status = 'sent',
      "deliveredAt" = now(),
      "lockedAt" = NULL,
      "lockedBy" = NULL,
      "nextAttemptAt" = NULL,
      last_error = NULL,
      provider_message_id = p_provider_message_id
  WHERE id = p_delivery_id
    AND status = 'processing'
    AND "lockedBy" = p_worker_id;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION mark_email_delivery_sent(uuid, uuid, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_email_delivery_sent(uuid, uuid, uuid, uuid, text, text) TO leadops_worker;
GRANT EXECUTE ON FUNCTION mark_email_delivery_sent(uuid, uuid, uuid, uuid, text, text) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 5. SECURITY DEFINER — mark email delivery failed (tenant-validated)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_email_delivery_failed(
  p_delivery_id uuid,
  p_org uuid,
  p_client uuid,
  p_integration_id uuid,
  p_worker_id text,
  p_error text,
  p_retryable boolean
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid;
  v_client uuid;
  v_integration_id uuid;
  rows_updated integer;
BEGIN
  IF NOT app_machine_can_access(p_org, p_client, p_integration_id) THEN
    RAISE EXCEPTION 'email delivery context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  SELECT e."organizationId", e."clientId", e."integrationId"
  INTO v_org, v_client, v_integration_id
  FROM email_deliveries e
  WHERE e.id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_org IS DISTINCT FROM p_org OR v_client IS DISTINCT FROM p_client
     OR v_integration_id IS DISTINCT FROM p_integration_id THEN
    RAISE EXCEPTION 'email delivery tenant binding mismatch'
      USING ERRCODE = '42501';
  END IF;

  UPDATE email_deliveries
  SET status = CASE
        WHEN NOT p_retryable OR attempt_count >= max_attempts THEN 'permanent_failure'
        ELSE 'pending'
      END,
      last_error = left(p_error, 2000),
      "nextAttemptAt" = CASE
        WHEN NOT p_retryable OR attempt_count >= max_attempts THEN NULL
        ELSE now()
          + (POWER(2, LEAST(attempt_count, 8)) * interval '1 second')
          + (random() * interval '1 second')
      END,
      "lockedAt" = NULL,
      "lockedBy" = NULL
  WHERE id = p_delivery_id
    AND status = 'processing'
    AND "lockedBy" = p_worker_id;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION mark_email_delivery_failed(uuid, uuid, uuid, uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_email_delivery_failed(uuid, uuid, uuid, uuid, text, text, boolean) TO leadops_worker;
GRANT EXECUTE ON FUNCTION mark_email_delivery_failed(uuid, uuid, uuid, uuid, text, text, boolean) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 6. SECURITY DEFINER — create email delivery (tenant-validated, idempotent)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_email_delivery_idempotent(
  p_org uuid,
  p_client uuid,
  p_integration_id uuid,
  p_template_name text,
  p_to_email text,
  p_subject text,
  p_html_body text,
  p_text_body text,
  p_idempotency_key text
) RETURNS TABLE(
  id uuid,
  oid uuid,
  cid uuid,
  st varchar,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_existing_id uuid;
  v_existing_template text;
  v_existing_subject text;
  v_existing_email text;
  v_existing_html text;
  v_existing_text text;
  v_existing_integration uuid;
BEGIN
  IF NOT (
    app_user_can_access_client(p_org, p_client)
    OR app_machine_can_access(p_org, p_client, p_integration_id)
  ) THEN
    RAISE EXCEPTION 'email delivery tenant context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'email delivery idempotency key is required'
      USING ERRCODE = '23514';
  END IF;

  IF p_integration_id IS NULL THEN
    RAISE EXCEPTION 'email delivery integration is required'
      USING ERRCODE = '23502';
  END IF;

  PERFORM 1
  FROM integrations i
  WHERE i.id = p_integration_id
    AND i."organizationId" = p_org
    AND i."clientId" = p_client
    AND i.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'email delivery integration binding is invalid'
      USING ERRCODE = '42501';
  END IF;

  -- Check existing idempotent record — read all immutable fields.
  SELECT e.id, e.template_name, e.subject, e.to_email, e.html_body,
         e.text_body, e."integrationId"
  INTO v_existing_id, v_existing_template, v_existing_subject,
       v_existing_email, v_existing_html, v_existing_text, v_existing_integration
  FROM email_deliveries e
  WHERE e."organizationId" = p_org
    AND e."clientId" = p_client
    AND e.idempotency_key = p_idempotency_key
  LIMIT 1;

  IF FOUND THEN
    -- Conflict if any immutable field differs.
    IF v_existing_template IS DISTINCT FROM p_template_name
       OR v_existing_subject IS DISTINCT FROM p_subject
       OR v_existing_email IS DISTINCT FROM p_to_email
       OR v_existing_html IS DISTINCT FROM p_html_body
       OR v_existing_text IS DISTINCT FROM p_text_body
       OR v_existing_integration IS DISTINCT FROM p_integration_id THEN
      RAISE EXCEPTION 'email delivery idempotency conflict: immutable field mismatch'
        USING ERRCODE = '23505';
    END IF;

    RETURN QUERY
    SELECT e.id, e."organizationId", e."clientId", e.status, false
    FROM email_deliveries e
    WHERE e.id = v_existing_id;
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO email_deliveries (
    "organizationId", "clientId", "integrationId",
    template_name, to_email, subject, html_body, text_body,
    idempotency_key, status
  ) VALUES (
    p_org, p_client, p_integration_id,
    p_template_name, p_to_email, p_subject, p_html_body, p_text_body,
    p_idempotency_key, 'pending'
  )
  RETURNING email_deliveries.id, email_deliveries."organizationId",
            email_deliveries."clientId", email_deliveries.status, true;
END
$$;

REVOKE EXECUTE ON FUNCTION create_email_delivery_idempotent(uuid, uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_email_delivery_idempotent(uuid, uuid, uuid, text, text, text, text, text, text) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION create_email_delivery_idempotent(uuid, uuid, uuid, text, text, text, text, text, text) TO leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 7. Worker job discovery functions
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_due_approval_expiration_jobs(
  p_batch_size integer DEFAULT 10
) RETURNS TABLE(
  "organizationId" uuid,
  "clientId" uuid,
  "integrationId" uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 1000';
  END IF;

  RETURN QUERY
  SELECT DISTINCT a."organizationId", a."clientId", a."integrationId"
  FROM approvals a
  JOIN integrations i
    ON i.id = a."integrationId"
   AND i."organizationId" = a."organizationId"
   AND i."clientId" = a."clientId"
   AND i.status = 'active'
  WHERE a.status = 'pending'
    AND a.expires_at <= now()
  ORDER BY a."organizationId", a."clientId", a."integrationId"
  LIMIT p_batch_size;
END
$$;

CREATE OR REPLACE FUNCTION list_due_approval_delivery_jobs(
  p_batch_size integer DEFAULT 10
) RETURNS TABLE(
  id uuid,
  "organizationId" uuid,
  "clientId" uuid,
  "integrationId" uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 1000';
  END IF;

  RETURN QUERY
  SELECT d.id, d."organizationId", d."clientId", d."integrationId"
  FROM approval_deliveries d
  JOIN integrations i
    ON i.id = d."integrationId"
   AND i."organizationId" = d."organizationId"
   AND i."clientId" = d."clientId"
   AND i.status = 'active'
  WHERE (
      d.status = 'pending'
      AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= now())
    ) OR (
      d.status = 'processing'
      AND d."lockedAt" < now() - interval '5 minutes'
    )
  ORDER BY d."nextAttemptAt" ASC NULLS FIRST, d."createdAt", d.id
  LIMIT p_batch_size;
END
$$;

CREATE OR REPLACE FUNCTION list_due_email_delivery_jobs(
  p_batch_size integer DEFAULT 10
) RETURNS TABLE(
  id uuid,
  "organizationId" uuid,
  "clientId" uuid,
  "integrationId" uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 1000';
  END IF;

  RETURN QUERY
  SELECT e.id, e."organizationId", e."clientId", e."integrationId"
  FROM email_deliveries e
  JOIN integrations i
    ON i.id = e."integrationId"
   AND i."organizationId" = e."organizationId"
   AND i."clientId" = e."clientId"
   AND i.status = 'active'
  WHERE (
      e.status = 'pending'
      AND (e."nextAttemptAt" IS NULL OR e."nextAttemptAt" <= now())
    ) OR (
      e.status = 'processing'
      AND e."lockedAt" < now() - interval '5 minutes'
    )
  ORDER BY e."nextAttemptAt" ASC NULLS FIRST, e."createdAt", e.id
  LIMIT p_batch_size;
END
$$;

REVOKE EXECUTE ON FUNCTION list_due_approval_expiration_jobs(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION list_due_approval_delivery_jobs(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION list_due_email_delivery_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_approval_expiration_jobs(integer) TO leadops_worker, leadops_worker_test;
GRANT EXECUTE ON FUNCTION list_due_approval_delivery_jobs(integer) TO leadops_worker, leadops_worker_test;
GRANT EXECUTE ON FUNCTION list_due_email_delivery_jobs(integer) TO leadops_worker, leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 8. Integration-scoped approval expiration and exact delivery claim
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION expire_pending_approvals_for_integration(
  p_org uuid,
  p_client uuid,
  p_integration_id uuid
) RETURNS TABLE(
  approval_id uuid,
  was_expired boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  rec RECORD;
BEGIN
  IF NOT app_machine_can_access(p_org, p_client, p_integration_id) THEN
    RAISE EXCEPTION 'approval expire context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  FOR rec IN (
    SELECT a.id, a."leadId", a.version
    FROM approvals a
    WHERE a."organizationId" = p_org
      AND a."clientId" = p_client
      AND a."integrationId" = p_integration_id
      AND a.status = 'pending'
      AND a.expires_at < now()
    FOR UPDATE SKIP LOCKED
  ) LOOP
    UPDATE approvals
    SET status = 'expired',
        version = version + 1,
        "updatedAt" = now()
    WHERE id = rec.id
      AND status = 'pending';

    IF FOUND THEN
      INSERT INTO approval_history (
        "approvalId", "organizationId", "clientId",
        previous_status, new_status, "command", "performedBy"
      ) VALUES (
        rec.id, p_org, p_client,
        'pending', 'expired', 'expire', 'system'
      );

      INSERT INTO approval_deliveries (
        "approvalId", "organizationId", "clientId", "integrationId",
        message_type, status, payload, idempotency_key
      ) VALUES (
        rec.id, p_org, p_client, p_integration_id,
        'approval.completed', 'pending',
        jsonb_strip_nulls(jsonb_build_object(
          'eventType', 'approval.completed',
          'approvalId', rec.id,
          'leadId', rec."leadId",
          'status', 'expired',
          'decidedBy', 'system',
          'decidedAt', now(),
          'version', rec.version + 1
        )),
        format('approval-completed-%s-%s', rec.id, rec.version + 1)
      );

      approval_id := rec.id;
      was_expired := true;
      RETURN NEXT;
    END IF;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION claim_approval_delivery_exact(
  p_delivery_id uuid,
  p_org uuid,
  p_client uuid,
  p_integration_id uuid,
  p_worker_id text
) RETURNS TABLE(
  id uuid,
  "approvalId" uuid,
  "organizationId" uuid,
  "clientId" uuid,
  "integrationId" uuid,
  message_type varchar,
  status varchar,
  attempt_count integer,
  max_attempts integer,
  last_error text,
  payload jsonb,
  idempotency_key text,
  "createdAt" timestamptz,
  callback_url text,
  encrypted_secret text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_row approval_deliveries%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) = 0 THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  IF NOT app_machine_can_access(p_org, p_client, p_integration_id) THEN
    RAISE EXCEPTION 'approval delivery context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM approval_deliveries d
  WHERE d.id = p_delivery_id
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_row."organizationId" IS DISTINCT FROM p_org
     OR v_row."clientId" IS DISTINCT FROM p_client
     OR v_row."integrationId" IS DISTINCT FROM p_integration_id THEN
    RAISE EXCEPTION 'approval delivery tenant binding mismatch'
      USING ERRCODE = '42501';
  END IF;

  IF v_row.status = 'pending' THEN
    IF v_row."nextAttemptAt" IS NOT NULL AND v_row."nextAttemptAt" > now() THEN
      RETURN;
    END IF;
  ELSIF v_row.status = 'processing' THEN
    IF v_row."lockedAt" >= now() - interval '5 minutes' THEN
      RETURN;
    END IF;
  ELSE
    RETURN;
  END IF;

  UPDATE approval_deliveries d
  SET status = 'processing',
      attempt_count = d.attempt_count + 1,
      "lockedAt" = now(),
      "lockedBy" = p_worker_id
  WHERE d.id = p_delivery_id;

  RETURN QUERY
  SELECT d.id, d."approvalId", d."organizationId", d."clientId",
         d."integrationId", d.message_type, d.status,
         d.attempt_count, d.max_attempts, d.last_error, d.payload,
         d.idempotency_key, d."createdAt", i.callback_url, secret.encrypted_secret
  FROM approval_deliveries d
  JOIN integrations i
    ON i.id = d."integrationId"
   AND i."organizationId" = d."organizationId"
   AND i."clientId" = d."clientId"
   AND i.status = 'active'
  LEFT JOIN LATERAL (
    SELECT s.encrypted_secret
    FROM integration_secrets s
    WHERE s."integrationId" = d."integrationId"
      AND s."organizationId" = d."organizationId"
      AND (s."revokedAt" IS NULL OR s."revokedAt" > now())
    ORDER BY s.version DESC
    LIMIT 1
  ) secret ON true
  WHERE d.id = p_delivery_id;
END
$$;

REVOKE EXECUTE ON FUNCTION expire_pending_approvals_for_integration(uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_approval_delivery_exact(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_pending_approvals_for_integration(uuid, uuid, uuid) TO leadops_worker, leadops_worker_test;
GRANT EXECUTE ON FUNCTION claim_approval_delivery_exact(uuid, uuid, uuid, uuid, text) TO leadops_worker, leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 9. Updated worker grants (additive to Phase 5)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_grant_worker(_role text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), _role);
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), _role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', _role);
  EXECUTE format('GRANT SELECT ON business_events TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workflows TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workflow_runs TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON outbox TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON leads TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON lead_status_history TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON ai_runs TO %I', _role);
  EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON email_deliveries FROM %I', _role);
  EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON approval_deliveries FROM %I', _role);
  EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON approvals FROM %I', _role);
END
$$;

SELECT app_grant_worker('leadops_worker');
SELECT app_grant_worker('leadops_worker_test');
REVOKE EXECUTE ON FUNCTION app_grant_worker(text) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 10. Updated runtime grants (additive)
-- ----------------------------------------------------------------------------
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

  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON integrations TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON integration_secrets TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workflows TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workflow_runs TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON business_events TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON outbox TO %I', _role);

  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON leads TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON lead_status_history TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON ai_runs TO %I', _role);

  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON approvals FROM %I', _role);
  EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON approval_tokens FROM %I', _role);
  EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON approval_deliveries FROM %I', _role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON approval_history FROM %I', _role);
  EXECUTE format('GRANT SELECT ON approvals TO %I', _role);
  EXECUTE format('GRANT SELECT ON approval_history TO %I', _role);

  EXECUTE format('GRANT SELECT, INSERT ON email_deliveries TO %I', _role);

  EXECUTE format('REVOKE UPDATE ("platform_admin") ON users FROM %I', _role);
END
$$;

SELECT app_grant_runtime('leadops_runtime');
SELECT app_grant_runtime('leadops_runtime_test');
REVOKE EXECUTE ON FUNCTION app_grant_runtime(text) FROM PUBLIC;
