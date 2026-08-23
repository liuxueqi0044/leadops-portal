-- 0008_phase4_security_hardening.sql — close Phase 4 tenant-boundary gaps
--
-- Phase 4 lead tables do not carry integrationId, so their machine RLS helper
-- must resolve the active integration selected by the verified event context.
-- SECURITY DEFINER entry points must repeat that authorization check because
-- their owner can bypass RLS.

CREATE OR REPLACE FUNCTION app_machine_can_access_tenant(
  p_org uuid,
  p_client uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM integrations i
    WHERE i.id = app_integration_id()
      AND i.status = 'active'
      AND i."organizationId" = p_org
      AND i."organizationId" = app_org_id()
      AND i."clientId" = p_client
      AND i."clientId" = app_client_id()
  );
$$;

CREATE OR REPLACE FUNCTION upsert_lead_dedupe(
  p_org uuid,
  p_client uuid,
  p_source text,
  p_external_id text,
  p_dedupe_key text,
  p_dedupe_version integer,
  p_contact_name text,
  p_email text,
  p_phone text,
  p_company text,
  p_message text,
  p_received_at timestamptz
) RETURNS TABLE(
  lid uuid,
  oid uuid,
  cid uuid,
  st varchar,
  inew boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_org uuid;
  v_client uuid;
  v_status varchar;
  v_new boolean;
BEGIN
  IF NOT (
    app_machine_can_access_tenant(p_org, p_client)
    OR app_user_can_access_client(p_org, p_client)
  ) THEN
    RAISE EXCEPTION 'lead tenant context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO leads AS l (
    "organizationId", "clientId", source, "externalId",
    "dedupeKey", "dedupeVersion", status,
    "contactName", email, phone, company, message,
    "receivedAt"
  ) VALUES (
    p_org, p_client, p_source, p_external_id,
    p_dedupe_key, p_dedupe_version, 'received',
    p_contact_name, p_email, p_phone, p_company, p_message,
    p_received_at
  )
  ON CONFLICT ("clientId", "dedupeVersion", "dedupeKey") DO UPDATE SET
    "contactName" = COALESCE(l."contactName", EXCLUDED."contactName"),
    email = COALESCE(l.email, EXCLUDED.email),
    phone = COALESCE(l.phone, EXCLUDED.phone),
    company = COALESCE(l.company, EXCLUDED.company),
    message = COALESCE(l.message, EXCLUDED.message),
    "updatedAt" = now()
    WHERE l.status NOT IN ('converted', 'archived')
  RETURNING l.id, l."organizationId", l."clientId", l.status,
    CASE WHEN l.xmax = 0 THEN true ELSE false END
  INTO v_id, v_org, v_client, v_status, v_new;

  -- ON CONFLICT ... DO UPDATE ... WHERE returns no row when the existing lead
  -- is terminal. Return the existing immutable aggregate instead of a row of
  -- NULLs so replays remain idempotent and callers never enqueue a NULL job.
  IF NOT FOUND THEN
    SELECT l.id, l."organizationId", l."clientId", l.status, false
    INTO v_id, v_org, v_client, v_status, v_new
    FROM leads l
    WHERE l."organizationId" = p_org
      AND l."clientId" = p_client
      AND l."dedupeVersion" = p_dedupe_version
      AND l."dedupeKey" = p_dedupe_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'lead upsert conflict could not be resolved'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  lid := v_id;
  oid := v_org;
  cid := v_client;
  st := v_status;
  inew := v_new;
  RETURN NEXT;
END
$$;

CREATE OR REPLACE FUNCTION lookup_lead_by_external(
  p_org uuid,
  p_client uuid,
  p_source text,
  p_external_id text
) RETURNS TABLE(
  internal_id uuid,
  current_status varchar
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (
    app_machine_can_access_tenant(p_org, p_client)
    OR app_user_can_access_client(p_org, p_client)
  ) THEN
    RAISE EXCEPTION 'lead tenant context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT l.id, l.status
    FROM leads l
    WHERE l."organizationId" = p_org
      AND l."clientId" = p_client
      AND l.source = p_source
      AND l."externalId" = p_external_id
    LIMIT 1;
END
$$;

CREATE OR REPLACE FUNCTION apply_lead_status_atomic(
  p_lead_id uuid,
  p_org uuid,
  p_client uuid,
  p_command varchar,
  p_new_status varchar,
  p_performed_by varchar,
  p_previous_status varchar DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_current varchar;
  v_allowed boolean;
BEGIN
  IF NOT (
    app_machine_can_access_tenant(p_org, p_client)
    OR app_user_can_access_client(p_org, p_client)
  ) THEN
    RAISE EXCEPTION 'lead tenant context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_current
  FROM leads
  WHERE id = p_lead_id
    AND "organizationId" = p_org
    AND "clientId" = p_client;

  IF NOT FOUND OR v_current IN ('converted', 'archived') THEN
    RETURN false;
  END IF;

  v_allowed := false;
  IF v_current = 'received' AND p_command = 'qualify' AND p_new_status = 'qualified' THEN v_allowed := true; END IF;
  IF v_current = 'received' AND p_command = 'needs_review' AND p_new_status = 'needs_review' THEN v_allowed := true; END IF;
  IF v_current = 'received' AND p_command = 'archive' AND p_new_status = 'archived' THEN v_allowed := true; END IF;
  IF v_current IN ('qualified','needs_review') AND p_command = 'approve' AND p_new_status = 'approved' THEN v_allowed := true; END IF;
  IF v_current IN ('qualified','needs_review') AND p_command = 'reject' AND p_new_status = 'rejected' THEN v_allowed := true; END IF;
  IF v_current IN ('qualified','needs_review') AND p_command = 'archive' AND p_new_status = 'archived' THEN v_allowed := true; END IF;
  IF v_current = 'approved' AND p_command = 'convert' AND p_new_status = 'converted' THEN v_allowed := true; END IF;
  IF v_current = 'approved' AND p_command = 'archive' AND p_new_status = 'archived' THEN v_allowed := true; END IF;
  IF v_current = 'rejected' AND p_command = 'archive' AND p_new_status = 'archived' THEN v_allowed := true; END IF;

  IF NOT v_allowed THEN
    RETURN false;
  END IF;

  UPDATE leads
  SET status = p_new_status, "updatedAt" = now()
  WHERE id = p_lead_id
    AND "organizationId" = p_org
    AND "clientId" = p_client
    AND status = v_current;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO lead_status_history (
    "leadId", "organizationId", "clientId",
    "previousStatus", "newStatus", command, "performedBy"
  ) VALUES (
    p_lead_id, p_org, p_client,
    COALESCE(p_previous_status, v_current), p_new_status, p_command, p_performed_by
  );

  RETURN true;
END
$$;

REVOKE EXECUTE ON FUNCTION upsert_lead_dedupe(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lookup_lead_by_external(uuid, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION apply_lead_status_atomic(uuid, uuid, uuid, varchar, varchar, varchar, varchar) FROM PUBLIC;

-- A lead projector must enqueue the follow-up leads.qualify job. Direct
-- worker inserts remain constrained by outbox_insert, whose machine policy
-- verifies the active integration/org/client binding against integrations.
GRANT SELECT, INSERT ON outbox TO leadops_worker;
GRANT SELECT, INSERT ON outbox TO leadops_worker_test;

-- Superseded by apply_lead_status_atomic(), which authorizes the tenant and
-- writes the state transition plus history in the same statement/transaction.
DROP FUNCTION IF EXISTS update_lead_status_machine(uuid, uuid, uuid, varchar, varchar, varchar);
