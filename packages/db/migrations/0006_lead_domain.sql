-- 0006_lead_domain.sql — Phase 4: leads, lead_status_history, ai_runs
--
-- All tenant tables have organizationId and clientId with composite FKs.
-- RLS is enabled and forced on all three tables.
-- Worker grants are additive; they do not replace Phase 1–3 grants.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  source varchar(100) NOT NULL,
  "externalId" varchar(300),
  "dedupeKey" varchar(500) NOT NULL,
  "dedupeVersion" integer NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'qualified', 'needs_review', 'approved', 'rejected', 'converted', 'archived')),
  "contactName" varchar(300),
  email varchar(320),
  phone varchar(100),
  company varchar(300),
  message text,
  score integer CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  "qualificationDecision" varchar(20)
    CHECK ("qualificationDecision" IS NULL OR "qualificationDecision" IN ('qualified', 'needs_review', 'disqualified')),
  "qualificationSummary" varchar(500),
  "qualificationConfidence" double precision
    CHECK ("qualificationConfidence" IS NULL OR ("qualificationConfidence" >= 0 AND "qualificationConfidence" <= 1)),
  "suggestedNextAction" varchar(50),
  metadata jsonb,
  "receivedAt" timestamptz,
  "qualifiedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("clientId", "organizationId") REFERENCES clients(id, "organizationId"),
  UNIQUE ("clientId", source, "externalId"),
  UNIQUE (id, "organizationId"),
  UNIQUE (id, "organizationId", "clientId")
);

CREATE INDEX IF NOT EXISTS leads_dedupe_key_idx ON leads ("clientId", "dedupeKey");
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads ("organizationId", "clientId", status);
CREATE INDEX IF NOT EXISTS leads_org_received_idx ON leads ("organizationId", "receivedAt" DESC);

CREATE TABLE IF NOT EXISTS lead_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "leadId" uuid NOT NULL,
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  "previousStatus" varchar(20),
  "newStatus" varchar(20) NOT NULL,
  "command" varchar(50) NOT NULL,
  "performedBy" varchar(50) NOT NULL DEFAULT 'system',
  "metadata" jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("leadId", "organizationId", "clientId") REFERENCES leads(id, "organizationId", "clientId")
);

CREATE INDEX IF NOT EXISTS lead_status_history_lead_idx ON lead_status_history ("leadId", "createdAt");

CREATE TABLE IF NOT EXISTS ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  "leadId" uuid NOT NULL,
  provider varchar(100) NOT NULL,
  model varchar(200) NOT NULL,
  "promptVersion" varchar(50) NOT NULL,
  "inputHash" varchar(200) NOT NULL,
  result jsonb,
  tokens jsonb,
  cost jsonb,
  "latencyMs" integer NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'failed', 'timeout', 'schema_error', 'budget_exceeded')),
  "errorClassification" varchar(100),
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("leadId", "organizationId", "clientId") REFERENCES leads(id, "organizationId", "clientId")
);

CREATE INDEX IF NOT EXISTS ai_runs_lead_idx ON ai_runs ("leadId");

-- ----------------------------------------------------------------------------
-- 2. Machine context helper for tables without integrationId
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_machine_can_access_tenant(
  p_org uuid,
  p_client uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT app_integration_id() IS NOT NULL
    AND app_org_id() = p_org
    AND app_client_id() = p_client;
$$;

-- ----------------------------------------------------------------------------
-- 3. RLS policies — leads
-- ----------------------------------------------------------------------------
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leads_select ON leads;
CREATE POLICY leads_select ON leads FOR SELECT
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access_tenant("organizationId", "clientId")
  );

DROP POLICY IF EXISTS leads_insert ON leads;
CREATE POLICY leads_insert ON leads FOR INSERT
  WITH CHECK (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access_tenant("organizationId", "clientId")
  );

DROP POLICY IF EXISTS leads_update ON leads;
CREATE POLICY leads_update ON leads FOR UPDATE
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access_tenant("organizationId", "clientId")
  );

-- ----------------------------------------------------------------------------
-- 4. RLS policies — lead_status_history
-- ----------------------------------------------------------------------------
ALTER TABLE lead_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_status_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_status_history_select ON lead_status_history;
CREATE POLICY lead_status_history_select ON lead_status_history FOR SELECT
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access_tenant("organizationId", "clientId")
  );

DROP POLICY IF EXISTS lead_status_history_insert ON lead_status_history;
CREATE POLICY lead_status_history_insert ON lead_status_history FOR INSERT
  WITH CHECK (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access_tenant("organizationId", "clientId")
  );

-- ----------------------------------------------------------------------------
-- 5. RLS policies — ai_runs
-- ----------------------------------------------------------------------------
ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_runs_select ON ai_runs;
CREATE POLICY ai_runs_select ON ai_runs FOR SELECT
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access_tenant("organizationId", "clientId")
  );

DROP POLICY IF EXISTS ai_runs_insert ON ai_runs;
CREATE POLICY ai_runs_insert ON ai_runs FOR INSERT
  WITH CHECK (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access_tenant("organizationId", "clientId")
  );

-- ----------------------------------------------------------------------------
-- 5. Incremental runtime grants (additive, preserves Phase 1–3)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_grant_phase4_runtime(_role text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON leads TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON lead_status_history TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON ai_runs TO %I', _role);
END
$$;

SELECT app_grant_phase4_runtime('leadops_runtime');
SELECT app_grant_phase4_runtime('leadops_runtime_test');
REVOKE EXECUTE ON FUNCTION app_grant_phase4_runtime(text) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 6. Incremental worker grants (additive, preserves Phase 3 worker grants)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_grant_phase4_worker(_role text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON leads TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON lead_status_history TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON ai_runs TO %I', _role);
END
$$;

SELECT app_grant_phase4_worker('leadops_worker');
SELECT app_grant_phase4_worker('leadops_worker_test');
REVOKE EXECUTE ON FUNCTION app_grant_phase4_worker(text) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 7. Security definer: upsert lead (for machine-to-machine projection)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_lead_machine(
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
  "organizationId" uuid,
  "clientId" uuid,
  status varchar,
  is_new boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_is_new boolean := false;
BEGIN
  IF p_external_id IS NOT NULL AND p_source IS NOT NULL THEN
    SELECT l.id INTO v_id
    FROM leads l
    WHERE l."clientId" = p_client
      AND l.source = p_source
      AND l."externalId" = p_external_id;
  END IF;

  IF v_id IS NOT NULL THEN
    UPDATE leads
    SET "contactName" = COALESCE(leads."contactName", p_contact_name),
        email = COALESCE(leads.email, p_email),
        phone = COALESCE(leads.phone, p_phone),
        company = COALESCE(leads.company, p_company),
        message = COALESCE(leads.message, p_message),
        "updatedAt" = now()
    WHERE leads.id = v_id
      AND leads.status NOT IN ('converted', 'rejected', 'archived');

    RETURN QUERY
    SELECT l.id, l."organizationId", l."clientId", l.status, false
    FROM leads l WHERE l.id = v_id;
  ELSE
    INSERT INTO leads (
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
    RETURNING leads.id INTO v_id;
    v_is_new := true;

    RETURN QUERY
    SELECT l.id, l."organizationId", l."clientId", l.status, true
    FROM leads l WHERE l.id = v_id;
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION upsert_lead_machine(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_lead_machine(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION upsert_lead_machine(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) TO leadops_runtime_test;
GRANT EXECUTE ON FUNCTION upsert_lead_machine(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) TO leadops_worker;
GRANT EXECUTE ON FUNCTION upsert_lead_machine(uuid, uuid, text, text, text, integer, text, text, text, text, text, timestamptz) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 8. Security definer: update lead status (domain-constrained state machine)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_lead_status_machine(
  p_lead_id uuid,
  p_org uuid,
  p_client uuid,
  p_new_status varchar,
  p_command varchar,
  p_performed_by varchar DEFAULT 'system'
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_current_status varchar;
  rows_updated integer;
BEGIN
  SELECT status INTO v_current_status
  FROM leads
  WHERE id = p_lead_id
    AND "organizationId" = p_org
    AND "clientId" = p_client;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Guard: terminal status no transition
  IF v_current_status IN ('converted', 'archived') THEN
    RETURN false;
  END IF;

  -- Guard: state machine validation
  IF v_current_status = 'received' AND p_new_status NOT IN ('qualified', 'needs_review', 'archived') THEN
    RETURN false;
  END IF;
  IF v_current_status IN ('qualified', 'needs_review') AND p_new_status NOT IN ('approved', 'rejected', 'archived') THEN
    RETURN false;
  END IF;
  IF v_current_status = 'approved' AND p_new_status NOT IN ('converted', 'archived') THEN
    RETURN false;
  END IF;
  IF v_current_status = 'rejected' AND p_new_status != 'archived' THEN
    RETURN false;
  END IF;

  UPDATE leads
  SET status = p_new_status,
      "updatedAt" = now()
  WHERE id = p_lead_id
    AND "organizationId" = p_org
    AND "clientId" = p_client
    AND status = v_current_status;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION update_lead_status_machine(uuid, uuid, uuid, varchar, varchar, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_lead_status_machine(uuid, uuid, uuid, varchar, varchar, varchar) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION update_lead_status_machine(uuid, uuid, uuid, varchar, varchar, varchar) TO leadops_runtime_test;
GRANT EXECUTE ON FUNCTION update_lead_status_machine(uuid, uuid, uuid, varchar, varchar, varchar) TO leadops_worker;
GRANT EXECUTE ON FUNCTION update_lead_status_machine(uuid, uuid, uuid, varchar, varchar, varchar) TO leadops_worker_test;
