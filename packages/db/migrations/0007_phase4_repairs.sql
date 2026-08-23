-- 0007_phase4_repairs.sql — Phase 4 acceptance repairs
--
-- Repairs dedupe uniqueness, outbox routing, state machine validation,
-- and externalId lookup without modifying 0001–0006.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Dedupe: add unique constraint on (clientId, dedupeVersion, dedupeKey)
--    and a SECURITY DEFINER upsert that uses atomic dedupe-key-based
--    INSERT … ON CONFLICT.
-- ----------------------------------------------------------------------------

-- The existing index is non-unique; replace it with a unique index that
-- includes dedupeVersion so version bumps can coexist during migration.
DROP INDEX IF EXISTS leads_dedupe_key_idx;
CREATE UNIQUE INDEX IF NOT EXISTS leads_dedupe_unique
  ON leads ("clientId", "dedupeVersion", "dedupeKey");

-- Atomic dedupe-aware upsert: uses dedupeKey as the primary conflict
-- resolution.  Returns (id, isNew) so the caller can conditionally write
-- history and schedule a qualification job.
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
  -- Try insert with ON CONFLICT on dedupe unique index
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

  lid := v_id;
  oid := v_org;
  cid := v_client;
  st := v_status;
  inew := v_new;
  RETURN NEXT;
END
$$;

REVOKE EXECUTE ON FUNCTION upsert_lead_dedupe(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_lead_dedupe(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION upsert_lead_dedupe(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) TO leadops_runtime_test;
GRANT EXECUTE ON FUNCTION upsert_lead_dedupe(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) TO leadops_worker;
GRANT EXECUTE ON FUNCTION upsert_lead_dedupe(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 2. lead.qualified: lookup by (org, client, source, externalId)
--    since event.data.leadId is the external system id, not our UUID.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lookup_lead_by_external(
  p_org uuid,
  p_client uuid,
  p_source text,
  p_external_id text
) RETURNS TABLE(
  internal_id uuid,
  current_status varchar
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT l.id, l.status
  FROM leads l
  WHERE l."organizationId" = p_org
    AND l."clientId" = p_client
    AND l.source = p_source
    AND l."externalId" = p_external_id
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION lookup_lead_by_external(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_lead_by_external(uuid, uuid, text, text) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION lookup_lead_by_external(uuid, uuid, text, text) TO leadops_runtime_test;
GRANT EXECUTE ON FUNCTION lookup_lead_by_external(uuid, uuid, text, text) TO leadops_worker;
GRANT EXECUTE ON FUNCTION lookup_lead_by_external(uuid, uuid, text, text) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 3. Atomic status update + history in one call (command-aware)
-- ----------------------------------------------------------------------------
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
  -- Read current status
  SELECT status INTO v_current
  FROM leads
  WHERE id = p_lead_id
    AND "organizationId" = p_org
    AND "clientId" = p_client;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Terminal guard
  IF v_current IN ('converted', 'archived') THEN
    RETURN false;
  END IF;

  -- Command-aware state machine validation
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

  -- Update status
  UPDATE leads
  SET status = p_new_status, "updatedAt" = now()
  WHERE id = p_lead_id
    AND "organizationId" = p_org
    AND "clientId" = p_client
    AND status = v_current;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Write history
  INSERT INTO lead_status_history (
    "leadId", "organizationId", "clientId",
    "previousStatus", "newStatus", "command", "performedBy"
  ) VALUES (
    p_lead_id, p_org, p_client,
    COALESCE(p_previous_status, v_current), p_new_status, p_command, p_performed_by
  );

  RETURN true;
END
$$;

REVOKE EXECUTE ON FUNCTION apply_lead_status_atomic(uuid, uuid, uuid, varchar, varchar, varchar, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_lead_status_atomic(uuid, uuid, uuid, varchar, varchar, varchar, varchar) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION apply_lead_status_atomic(uuid, uuid, uuid, varchar, varchar, varchar, varchar) TO leadops_runtime_test;
GRANT EXECUTE ON FUNCTION apply_lead_status_atomic(uuid, uuid, uuid, varchar, varchar, varchar, varchar) TO leadops_worker;
GRANT EXECUTE ON FUNCTION apply_lead_status_atomic(uuid, uuid, uuid, varchar, varchar, varchar, varchar) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 4. Supersede the old upsert_lead_machine (use new dedupe-upsert everywhere)
--    Drop the old function so SQL calls use the new one.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS upsert_lead_machine(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz);
