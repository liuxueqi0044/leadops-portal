-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadops_worker') THEN
    CREATE ROLE leadops_worker LOGIN PASSWORD 'leadops_worker_dev'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadops_worker_test') THEN
    CREATE ROLE leadops_worker_test LOGIN PASSWORD 'leadops_worker_test_dev'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION leadops_worker;
CREATE SCHEMA IF NOT EXISTS pgboss_test AUTHORIZATION leadops_worker_test;
-- 0005_event_platform.sql — Phase 3: signed events, idempotency, outbox
--
-- Creates integrations, secrets, workflows, workflow_runs, business_events
-- and outbox tables. All tenant tables have FORCE RLS.
-- Machine-to-machine event ingestion uses integration-level context
-- (app.integration_id) validated against the actual integration record.
-- Business events are append-only for runtime roles.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  name varchar(200) NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("clientId", "organizationId") REFERENCES clients(id, "organizationId"),
  UNIQUE (id, "organizationId"),
  UNIQUE (id, "organizationId", "clientId"),
  UNIQUE ("organizationId", "clientId", name)
);

CREATE TABLE IF NOT EXISTS integration_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "integrationId" uuid NOT NULL,
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  encrypted_secret text NOT NULL,
  "activeFrom" timestamptz NOT NULL DEFAULT now(),
  "revokedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("integrationId", "organizationId") REFERENCES integrations(id, "organizationId"),
  UNIQUE ("integrationId", version)
);

CREATE TABLE IF NOT EXISTS workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "integrationId" uuid NOT NULL,
  "clientId" uuid NOT NULL,
  "externalId" varchar(200) NOT NULL,
  name varchar(200) NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("integrationId", "organizationId", "clientId")
    REFERENCES integrations(id, "organizationId", "clientId"),
  UNIQUE (id, "organizationId", "clientId"),
  UNIQUE ("integrationId", "externalId")
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  "workflowId" uuid NOT NULL,
  "externalRunId" varchar(200) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'succeeded', 'failed')),
  "startedAt" timestamptz,
  "succeededAt" timestamptz,
  "failedAt" timestamptz,
  error jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("workflowId", "organizationId", "clientId")
    REFERENCES workflows(id, "organizationId", "clientId"),
  UNIQUE ("workflowId", "externalRunId")
);

CREATE TABLE IF NOT EXISTS business_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "integrationId" uuid NOT NULL,
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  "webhookId" varchar(200) NOT NULL,
  "eventType" varchar(200) NOT NULL,
  raw_json jsonb NOT NULL,
  body_hash varchar(128) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'projected', 'unhandled', 'failed')),
  error_message text,
  "receivedAt" timestamptz NOT NULL DEFAULT now(),
  "projectedAt" timestamptz,

  FOREIGN KEY ("integrationId", "organizationId", "clientId")
    REFERENCES integrations(id, "organizationId", "clientId"),
  UNIQUE ("integrationId", "webhookId")
);

CREATE INDEX IF NOT EXISTS business_events_org_received_idx
  ON business_events ("organizationId", "receivedAt" DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "integrationId" uuid NOT NULL,
  "clientId" uuid NOT NULL,
  aggregate_type varchar(100) NOT NULL,
  aggregate_id varchar(200) NOT NULL,
  message_type varchar(200) NOT NULL,
  payload jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'dead_letter')),
  "lockedAt" timestamptz,
  "lockedBy" varchar(200),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  "nextAttemptAt" timestamptz DEFAULT now(),
  last_error text,
  "deliveredAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("integrationId", "organizationId", "clientId")
    REFERENCES integrations(id, "organizationId", "clientId")
);

CREATE INDEX IF NOT EXISTS outbox_status_attempt_idx
  ON outbox (status, "nextAttemptAt" ASC NULLS FIRST)
  WHERE status IN ('pending', 'processing');

-- ----------------------------------------------------------------------------
-- 2. Machine context helpers
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_integration_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' AS $$
  SELECT nullif(current_setting('app.integration_id', true), '')::uuid;
$$;

-- Machine access is valid only when every tenant key on the target row matches
-- the active integration selected by the verified webhook.
CREATE OR REPLACE FUNCTION app_machine_can_access(
  p_org uuid,
  p_client uuid,
  p_integration uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM integrations i
    WHERE i.id = p_integration
      AND i.id = app_integration_id()
      AND status = 'active'
      AND i."organizationId" = p_org
      AND i."organizationId" = app_org_id()
      AND i."clientId" = p_client
      AND i."clientId" = app_client_id()
  );
$$;

-- User visibility mirrors the client policies from Phase 2. Merely forging
-- app.* settings is insufficient: membership and client assignment are read
-- from server-owned rows.
CREATE OR REPLACE FUNCTION app_user_can_access_client(
  p_org uuid,
  p_client uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT app_is_active_member(p_org)
     AND (
       app_role() IN ('agency_owner', 'agency_admin')
       OR app_is_elevated_platform(p_org)
       OR EXISTS (
         SELECT 1 FROM client_assignments a
         WHERE a."organizationId" = p_org
           AND a."clientId" = p_client
           AND a."userId" = app_user_id()
       )
       OR EXISTS (
         SELECT 1 FROM client_members m
         WHERE m."organizationId" = p_org
           AND m."clientId" = p_client
           AND m."userId" = app_user_id()
       )
     );
$$;

-- ----------------------------------------------------------------------------
-- 3. RLS policies — integrations (user path only, machine uses SECURITY DEFINER)
-- ----------------------------------------------------------------------------
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integrations_select ON integrations;
DROP POLICY IF EXISTS integrations_insert ON integrations;
DROP POLICY IF EXISTS integrations_update ON integrations;
DROP POLICY IF EXISTS integrations_select ON integrations;
CREATE POLICY integrations_select ON integrations FOR SELECT
  USING (
    app_user_can_access_client("organizationId", "clientId")
  );

DROP POLICY IF EXISTS integrations_insert ON integrations;
CREATE POLICY integrations_insert ON integrations FOR INSERT
  WITH CHECK (
    app_ctx_valid() AND app_can_manage_clients("organizationId")
  );

DROP POLICY IF EXISTS integrations_update ON integrations;
CREATE POLICY integrations_update ON integrations FOR UPDATE
  USING (
    app_ctx_valid() AND app_can_manage_clients("organizationId")
  );

-- ----------------------------------------------------------------------------
-- 4. RLS policies — integration_secrets
-- ----------------------------------------------------------------------------
ALTER TABLE integration_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_secrets FORCE ROW LEVEL SECURITY;

-- Secrets SELECT is restricted: most operations use SECURITY DEFINER functions.
-- User path allows read for org management via app_can_manage_clients.
DROP POLICY IF EXISTS integration_secrets_select ON integration_secrets;
CREATE POLICY integration_secrets_select ON integration_secrets FOR SELECT
  USING (
    app_ctx_valid() AND app_can_manage_clients("organizationId")
  );

DROP POLICY IF EXISTS integration_secrets_insert ON integration_secrets;
CREATE POLICY integration_secrets_insert ON integration_secrets FOR INSERT
  WITH CHECK (
    app_ctx_valid() AND app_can_manage_clients("organizationId")
  );

DROP POLICY IF EXISTS integration_secrets_update ON integration_secrets;
CREATE POLICY integration_secrets_update ON integration_secrets FOR UPDATE
  USING (
    app_ctx_valid() AND app_can_manage_clients("organizationId")
  );

-- ----------------------------------------------------------------------------
-- 5. RLS policies — workflows
-- ----------------------------------------------------------------------------
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflows_select ON workflows;
CREATE POLICY workflows_select ON workflows FOR SELECT
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

DROP POLICY IF EXISTS workflows_insert ON workflows;
CREATE POLICY workflows_insert ON workflows FOR INSERT
  WITH CHECK (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

DROP POLICY IF EXISTS workflows_update ON workflows;
CREATE POLICY workflows_update ON workflows FOR UPDATE
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

-- ----------------------------------------------------------------------------
-- 6. RLS policies — workflow_runs
-- ----------------------------------------------------------------------------
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_runs_select ON workflow_runs;
CREATE POLICY workflow_runs_select ON workflow_runs FOR SELECT
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = "workflowId"
        AND app_machine_can_access(w."organizationId", w."clientId", w."integrationId")
    )
  );

DROP POLICY IF EXISTS workflow_runs_insert ON workflow_runs;
CREATE POLICY workflow_runs_insert ON workflow_runs FOR INSERT
  WITH CHECK (
    app_user_can_access_client("organizationId", "clientId")
    OR EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = "workflowId"
        AND app_machine_can_access(w."organizationId", w."clientId", w."integrationId")
    )
  );

DROP POLICY IF EXISTS workflow_runs_update ON workflow_runs;
CREATE POLICY workflow_runs_update ON workflow_runs FOR UPDATE
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = "workflowId"
        AND app_machine_can_access(w."organizationId", w."clientId", w."integrationId")
    )
  );

-- ----------------------------------------------------------------------------
-- 7. RLS policies — business_events (append-only for raw fields)
-- ----------------------------------------------------------------------------
ALTER TABLE business_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_events_select ON business_events;
CREATE POLICY business_events_select ON business_events FOR SELECT
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

DROP POLICY IF EXISTS business_events_insert ON business_events;
CREATE POLICY business_events_insert ON business_events FOR INSERT
  WITH CHECK (
    app_machine_can_access("organizationId", "clientId", "integrationId")
  );

-- UPDATE on status/projectedAt/error_message only (column-level grants restrict this)
DROP POLICY IF EXISTS business_events_update ON business_events;
CREATE POLICY business_events_update ON business_events FOR UPDATE
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

-- ----------------------------------------------------------------------------
-- 8. RLS policies — outbox
-- ----------------------------------------------------------------------------
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbox_select ON outbox;
CREATE POLICY outbox_select ON outbox FOR SELECT
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

DROP POLICY IF EXISTS outbox_insert ON outbox;
CREATE POLICY outbox_insert ON outbox FOR INSERT
  WITH CHECK (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

DROP POLICY IF EXISTS outbox_update ON outbox;
CREATE POLICY outbox_update ON outbox FOR UPDATE
  USING (
    app_user_can_access_client("organizationId", "clientId")
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

-- ----------------------------------------------------------------------------
-- 9a. Outbox claim function (SECURITY DEFINER — cross-tenant via FOR UPDATE SKIP LOCKED)
--     Only claims items whose lease has expired and nextAttemptAt has arrived.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_outbox_items(
  p_worker_id text,
  p_batch_size integer DEFAULT 10
) RETURNS TABLE(
  id uuid,
  "organizationId" uuid,
  "integrationId" uuid,
  "clientId" uuid,
  "aggregateType" varchar,
  "aggregateId" varchar,
  "messageType" varchar,
  payload jsonb,
  status varchar,
  "lockedAt" timestamptz,
  "lockedBy" varchar,
  "attemptCount" integer,
  "maxAttempts" integer,
  "nextAttemptAt" timestamptz,
  "lastError" text,
  "deliveredAt" timestamptz,
  "createdAt" timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) = 0 THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  IF p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 1000';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    SELECT o.id FROM outbox o
    WHERE (
      o.status = 'pending'
      AND (o."nextAttemptAt" IS NULL OR o."nextAttemptAt" <= now())
    ) OR (
      o.status = 'processing'
      AND o."lockedAt" < (now() - interval '5 minutes')
    )
    ORDER BY o."nextAttemptAt" ASC NULLS FIRST, o."createdAt", o.id
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE outbox o
  SET status = 'processing',
      "lockedAt" = now(),
      "lockedBy" = p_worker_id,
      attempt_count = o.attempt_count + 1
  FROM claimed c
  WHERE o.id = c.id
  RETURNING o.id, o."organizationId", o."integrationId", o."clientId",
            o.aggregate_type, o.aggregate_id, o.message_type,
            o.payload, o.status, o."lockedAt", o."lockedBy",
            o.attempt_count, o.max_attempts, o."nextAttemptAt",
            o.last_error, o."deliveredAt", o."createdAt";
END
$$;

REVOKE EXECUTE ON FUNCTION claim_outbox_items(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_outbox_items(text, integer) TO leadops_worker;
GRANT EXECUTE ON FUNCTION claim_outbox_items(text, integer) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 9b. Mark outbox delivered (SECURITY DEFINER — checks lockedBy for safety)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_outbox_delivered_safe(
  p_outbox_id uuid,
  p_worker_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  rows_updated integer;
BEGIN
  UPDATE outbox o
  SET status = 'delivered', "deliveredAt" = now(), "lockedAt" = NULL, "lockedBy" = NULL
  WHERE o.id = p_outbox_id AND o."lockedBy" = p_worker_id;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION mark_outbox_delivered_safe(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_outbox_delivered_safe(uuid, text) TO leadops_worker;
GRANT EXECUTE ON FUNCTION mark_outbox_delivered_safe(uuid, text) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 9c. Mark outbox failed / dead-letter (SECURITY DEFINER — checks lockedBy)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_outbox_failed_safe(
  p_outbox_id uuid,
  p_worker_id text,
  p_error text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  rows_updated integer;
BEGIN
  UPDATE outbox o
  SET status = CASE
        WHEN o.attempt_count >= o.max_attempts THEN 'dead_letter'
        ELSE 'pending'
      END,
      "lockedAt" = NULL,
      "lockedBy" = NULL,
      last_error = p_error,
      "nextAttemptAt" = CASE
        WHEN o.attempt_count >= o.max_attempts THEN NULL
        ELSE now()
          + (POWER(2, LEAST(o.attempt_count, 8)) * interval '1 second')
          + (random() * interval '1 second')
      END
  WHERE o.id = p_outbox_id AND o."lockedBy" = p_worker_id;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION mark_outbox_failed_safe(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_outbox_failed_safe(uuid, text, text) TO leadops_worker;
GRANT EXECUTE ON FUNCTION mark_outbox_failed_safe(uuid, text, text) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 9d. Mark business event projected (SECURITY DEFINER — allows status update)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_business_event_projected(
  p_event_id uuid,
  p_integration_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  rows_updated integer;
BEGIN
  UPDATE business_events
  SET status = 'projected', "projectedAt" = now()
  WHERE id = p_event_id
    AND "integrationId" = p_integration_id
    AND status != 'projected';
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION mark_business_event_projected(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION mark_business_event_result_safe(
  p_event_id uuid,
  p_integration_id uuid,
  p_status text,
  p_error text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  rows_updated integer;
BEGIN
  IF p_status NOT IN ('projected', 'unhandled', 'failed') THEN
    RAISE EXCEPTION 'invalid terminal event status';
  END IF;

  UPDATE business_events e
  SET status = p_status,
      "projectedAt" = CASE WHEN p_status IN ('projected', 'unhandled') THEN now() ELSE NULL END,
      error_message = CASE WHEN p_status = 'failed' THEN left(p_error, 1000) ELSE NULL END
  WHERE e.id = p_event_id
    AND e."integrationId" = p_integration_id
    AND (
      (p_status = 'failed' AND e.status IN ('received', 'failed'))
      OR
      (p_status IN ('projected', 'unhandled')
        AND e.status IN ('received', 'failed', p_status))
    )
    AND (
      app_machine_can_access(e."organizationId", e."clientId", e."integrationId")
      OR app_user_can_access_client(e."organizationId", e."clientId")
    );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION mark_business_event_result_safe(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_business_event_result_safe(uuid, uuid, text, text) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION mark_business_event_result_safe(uuid, uuid, text, text) TO leadops_runtime_test;
GRANT EXECUTE ON FUNCTION mark_business_event_result_safe(uuid, uuid, text, text) TO leadops_worker;
GRANT EXECUTE ON FUNCTION mark_business_event_result_safe(uuid, uuid, text, text) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 10. Integration verification lookup (SECURITY DEFINER — bypasses RLS
--     so the event route can locate the integration before setting context)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lookup_integration_for_verification(
  p_integration_id uuid
) RETURNS TABLE(
  id uuid,
  "organizationId" uuid,
  "clientId" uuid,
  name varchar,
  status varchar,
  secrets text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH integ AS (
    SELECT i.id, i."organizationId", i."clientId", i.name, i.status
    FROM integrations i
    WHERE i.id = p_integration_id
  ),
  secret_list AS (
    SELECT
      integ.id AS integration_id,
      array_agg(s.encrypted_secret ORDER BY s.version DESC) AS s_arr
    FROM integration_secrets s
    JOIN integ ON s."integrationId" = integ.id
    WHERE s."activeFrom" <= now()
      AND (
        s."revokedAt" IS NULL
        OR s."revokedAt" > now() - interval '5 minutes'
      )
    GROUP BY integ.id
  )
  SELECT
    integ.id, integ."organizationId", integ."clientId", integ.name, integ.status,
    COALESCE(sl.s_arr, ARRAY[]::text[])
  FROM integ
  LEFT JOIN secret_list sl ON sl.integration_id = integ.id
  WHERE integ.status != 'revoked';
END
$$;

REVOKE EXECUTE ON FUNCTION lookup_integration_for_verification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_integration_for_verification(uuid) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION lookup_integration_for_verification(uuid) TO leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 11. Updated grants to runtime roles (additive only, preserves Phase 2 grants)
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

  -- Phase 3 tables
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON integrations TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON integration_secrets TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workflows TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workflow_runs TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON business_events TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON outbox TO %I', _role);

  EXECUTE format('REVOKE UPDATE ("platform_admin") ON users FROM %I', _role);
END
$$;

SELECT app_grant_runtime('leadops_runtime');
SELECT app_grant_runtime('leadops_runtime_test');

REVOKE EXECUTE ON FUNCTION app_grant_runtime(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_grant_worker(_role text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), _role);
  -- pg-boss performs its own versioned schema migrations inside the dedicated
  -- pgboss/pgboss_test schema. The worker remains NOSUPERUSER/NOBYPASSRLS.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), _role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', _role);
  EXECUTE format('GRANT SELECT ON business_events TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workflows TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workflow_runs TO %I', _role);
END
$$;

SELECT app_grant_worker('leadops_worker');
SELECT app_grant_worker('leadops_worker_test');
REVOKE EXECUTE ON FUNCTION app_grant_worker(text) FROM PUBLIC;
