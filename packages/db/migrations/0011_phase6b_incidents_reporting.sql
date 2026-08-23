-- 0011_phase6b_incidents_reporting.sql — Phase 6B: Incidents, Report Snapshots, Operations API
--
-- incidents              — aggregated failure incidents by fingerprint
-- incident_events        — append-only state change log
-- report_snapshots       — immutable weekly metric snapshots
-- SECURITY DEFINER       — open/aggregate, state transitions, snapshot creation
-- Worker discovery       — list_due_weekly_report_clients
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. incidents table
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  "integrationId" uuid NOT NULL,
  "workflowId" uuid,
  fingerprint text NOT NULL,
  category varchar(64) NOT NULL,
  severity varchar(16) NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status varchar(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved')),
  "occurrenceCount" integer NOT NULL DEFAULT 1
    CHECK ("occurrenceCount" > 0),
  error_summary text,
  "firstSeenAt" timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
  "acknowledgedAt" timestamptz,
  "acknowledgedBy" varchar(200),
  "resolvedAt" timestamptz,
  "resolvedBy" varchar(200),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("clientId", "organizationId")
    REFERENCES clients(id, "organizationId"),
  FOREIGN KEY ("integrationId", "organizationId", "clientId")
    REFERENCES integrations(id, "organizationId", "clientId"),
  UNIQUE (id, "organizationId", "clientId"),
  UNIQUE ("organizationId", "clientId", fingerprint)
);

CREATE INDEX IF NOT EXISTS incidents_status_idx
  ON incidents ("organizationId", "clientId", status, "lastSeenAt" DESC);

CREATE INDEX IF NOT EXISTS incidents_fingerprint_idx
  ON incidents ("organizationId", "clientId", fingerprint);

-- ----------------------------------------------------------------------------
-- 2. incident_events table (append-only, no UPDATE/DELETE by business code)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  "incidentId" uuid NOT NULL,
  "occurrenceKey" varchar(500),
  event_type varchar(32) NOT NULL
    CHECK (event_type IN ('opened', 'occurred', 'acknowledged', 'resolved', 'reopened')),
  actor varchar(200),
  "correlationId" varchar(200),
  metadata jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("clientId", "organizationId")
    REFERENCES clients(id, "organizationId"),
  FOREIGN KEY ("incidentId", "organizationId", "clientId")
    REFERENCES incidents(id, "organizationId", "clientId")
);

CREATE INDEX IF NOT EXISTS incident_events_incident_idx
  ON incident_events ("incidentId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS incident_events_occurrence_unique
  ON incident_events ("organizationId", "clientId", "occurrenceKey")
  WHERE "occurrenceKey" IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. report_snapshots table
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  "integrationId" uuid NOT NULL,
  "periodStart" timestamptz NOT NULL,
  "periodEnd" timestamptz NOT NULL,
  "generationVersion" integer NOT NULL DEFAULT 1,
  metrics jsonb NOT NULL,
  "correlationId" varchar(200),
  "generatedAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("clientId", "organizationId")
    REFERENCES clients(id, "organizationId"),
  FOREIGN KEY ("integrationId", "organizationId", "clientId")
    REFERENCES integrations(id, "organizationId", "clientId"),
  CONSTRAINT report_snapshots_period_generation_unique
    UNIQUE ("organizationId", "clientId", "periodStart", "periodEnd", "generationVersion"),
  CHECK ("generationVersion" > 0),
  CHECK ("periodEnd" = "periodStart" + interval '7 days')
);

CREATE INDEX IF NOT EXISTS report_snapshots_period_idx
  ON report_snapshots ("organizationId", "clientId", "periodStart" DESC);

-- ----------------------------------------------------------------------------
-- 4. RLS — incidents
-- ----------------------------------------------------------------------------
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incidents_select ON incidents;
CREATE POLICY incidents_select ON incidents FOR SELECT
  USING (
    (app_ctx_valid()
     AND app_user_can_access_client("organizationId", "clientId"))
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

DROP POLICY IF EXISTS incidents_insert ON incidents;
CREATE POLICY incidents_insert ON incidents FOR INSERT
  WITH CHECK (
    app_machine_can_access("organizationId", "clientId", "integrationId")
  );

-- User-facing updates (acknowledge, resolve) allowed through user context;
-- SECURITY DEFINER functions (below) additionally gate concurrent modification.
DROP POLICY IF EXISTS incidents_update ON incidents;
CREATE POLICY incidents_update ON incidents FOR UPDATE
  USING (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

-- Machine (worker) updates only through SECURITY DEFINER functions.
-- No direct DELETE policy for business code.

-- ----------------------------------------------------------------------------
-- 5. RLS — incident_events
-- ----------------------------------------------------------------------------
ALTER TABLE incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incident_events_select ON incident_events;
CREATE POLICY incident_events_select ON incident_events FOR SELECT
  USING (
    (app_ctx_valid()
     AND app_user_can_access_client("organizationId", "clientId"))
    OR app_machine_can_access("organizationId", "clientId",
      (SELECT i."integrationId" FROM incidents i WHERE i.id = "incidentId" AND i."organizationId" = incident_events."organizationId"))
  );

DROP POLICY IF EXISTS incident_events_insert ON incident_events;
CREATE POLICY incident_events_insert ON incident_events FOR INSERT
  WITH CHECK (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

-- No UPDATE/DELETE policy on incident_events — append-only enforced by RLS.

-- ----------------------------------------------------------------------------
-- 6. RLS — report_snapshots
-- ----------------------------------------------------------------------------
ALTER TABLE report_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS report_snapshots_select ON report_snapshots;
CREATE POLICY report_snapshots_select ON report_snapshots FOR SELECT
  USING (
    (app_ctx_valid()
     AND app_user_can_access_client("organizationId", "clientId"))
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

DROP POLICY IF EXISTS report_snapshots_insert ON report_snapshots;
CREATE POLICY report_snapshots_insert ON report_snapshots FOR INSERT
  WITH CHECK (
    app_machine_can_access("organizationId", "clientId", "integrationId")
  );

-- No UPDATE/DELETE policy — immutable snapshots.

-- ----------------------------------------------------------------------------
-- 7. SECURITY DEFINER — open_or_aggregate_incident
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION open_or_aggregate_incident(
  p_org uuid,
  p_client uuid,
  p_integration_id uuid,
  p_occurrence_key text,
  p_workflow_id uuid,
  p_fingerprint text,
  p_category text,
  p_severity text,
  p_error_summary text,
  p_job_name text,
  p_correlation_id text
) RETURNS TABLE(
  id uuid,
  "organizationId" uuid,
  "clientId" uuid,
  fingerprint text,
  status varchar,
  "occurrenceCount" integer,
  "lastSeenAt" timestamptz,
  "isNew" boolean,
  "wasApplied" boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_existing incidents%ROWTYPE;
  v_new_id uuid;
  v_event_type varchar(32);
BEGIN
  IF NOT app_machine_can_access(p_org, p_client, p_integration_id) THEN
    RAISE EXCEPTION 'incident context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  IF p_fingerprint IS NULL OR length(trim(p_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fingerprint is required'
      USING ERRCODE = '23514';
  END IF;

  IF p_occurrence_key IS NULL OR length(trim(p_occurrence_key)) = 0
     OR length(p_occurrence_key) > 500 THEN
    RAISE EXCEPTION 'occurrence key is required and must be at most 500 characters'
      USING ERRCODE = '23514';
  END IF;

  IF p_severity NOT IN ('low', 'medium', 'high', 'critical') THEN
    RAISE EXCEPTION 'invalid incident severity'
      USING ERRCODE = '23514';
  END IF;

  -- Validate integration binding
  PERFORM 1
  FROM integrations i
  WHERE i.id = p_integration_id
    AND i."organizationId" = p_org
    AND i."clientId" = p_client
    AND i.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident integration binding is invalid'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize first creation and aggregation for this tenant fingerprint. A row
  -- lock alone cannot protect the initial insert because no row exists yet.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_org::text || '|' || p_client::text || '|' || p_fingerprint, 0)
  );

  -- A retried/de-duplicated job must not increment the incident a second time.
  SELECT i.* INTO v_existing
  FROM incident_events e
  JOIN incidents i
    ON i.id = e."incidentId"
   AND i."organizationId" = e."organizationId"
   AND i."clientId" = e."clientId"
  WHERE e."organizationId" = p_org
    AND e."clientId" = p_client
    AND e."occurrenceKey" = p_occurrence_key
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY
    SELECT i.id, i."organizationId", i."clientId", i.fingerprint, i.status,
           i."occurrenceCount", i."lastSeenAt", false, false
    FROM incidents i
    WHERE i.id = v_existing.id;
    RETURN;
  END IF;

  SELECT i.* INTO v_existing
  FROM incidents i
  WHERE i."organizationId" = p_org
    AND i."clientId" = p_client
    AND i.fingerprint = p_fingerprint
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_event_type := CASE
      WHEN v_existing.status = 'resolved' THEN 'reopened'
      ELSE 'occurred'
    END;

    UPDATE incidents i
    SET "occurrenceCount" = i."occurrenceCount" + 1,
        "lastSeenAt" = now(),
        error_summary = COALESCE(p_error_summary, i.error_summary),
        category = p_category,
        severity = p_severity,
        "workflowId" = COALESCE(p_workflow_id, i."workflowId"),
        status = CASE
          WHEN i.status = 'resolved' THEN 'open'
          ELSE i.status
        END,
        "updatedAt" = now(),
        "acknowledgedAt" = CASE
          WHEN i.status = 'resolved' THEN NULL
          ELSE i."acknowledgedAt"
        END,
        "acknowledgedBy" = CASE
          WHEN i.status = 'resolved' THEN NULL
          ELSE i."acknowledgedBy"
        END,
        "resolvedAt" = CASE
          WHEN i.status = 'resolved' THEN NULL
          ELSE i."resolvedAt"
        END,
        "resolvedBy" = CASE
          WHEN i.status = 'resolved' THEN NULL
          ELSE i."resolvedBy"
        END
    WHERE i.id = v_existing.id;

    INSERT INTO incident_events (
      "organizationId", "clientId", "incidentId", "occurrenceKey",
      event_type, actor, "correlationId", metadata
    ) VALUES (
      p_org, p_client, v_existing.id, p_occurrence_key,
      v_event_type, p_job_name, p_correlation_id,
      jsonb_build_object('category', p_category, 'severity', p_severity)
    );

    RETURN QUERY
    SELECT i.id, i."organizationId", i."clientId", i.fingerprint, i.status,
           i."occurrenceCount", i."lastSeenAt", false, true
    FROM incidents i WHERE i.id = v_existing.id;

  ELSE
    INSERT INTO incidents (
      "organizationId", "clientId", "integrationId", "workflowId",
      fingerprint, category, severity, status,
      "occurrenceCount", error_summary,
      "firstSeenAt", "lastSeenAt"
    ) VALUES (
      p_org, p_client, p_integration_id, p_workflow_id,
      p_fingerprint, p_category, p_severity, 'open',
      1, p_error_summary,
      now(), now()
    )
    RETURNING incidents.id INTO v_new_id;

    INSERT INTO incident_events (
      "organizationId", "clientId", "incidentId", "occurrenceKey",
      event_type, actor, "correlationId", metadata
    ) VALUES (
      p_org, p_client, v_new_id, p_occurrence_key,
      'opened', p_job_name, p_correlation_id,
      jsonb_build_object('category', p_category, 'severity', p_severity)
    );

    RETURN QUERY
    SELECT i.id, i."organizationId", i."clientId", i.fingerprint, i.status,
           i."occurrenceCount", i."lastSeenAt", true, true
    FROM incidents i WHERE i.id = v_new_id;
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION open_or_aggregate_incident(
  uuid, uuid, uuid, text, uuid, text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_or_aggregate_incident(
  uuid, uuid, uuid, text, uuid, text, text, text, text, text, text
) TO leadops_worker, leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 8. SECURITY DEFINER — acknowledge_incident
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION acknowledge_incident(
  p_incident_id uuid,
  p_org uuid,
  p_actor text,
  p_expected_status text,
  p_correlation_id text
) RETURNS TABLE(
  id uuid,
  status varchar,
  "acknowledgedAt" timestamptz,
  "acknowledgedBy" varchar,
  "updatedAt" timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_row incidents%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.user_id', true), '') IS NULL
     OR p_actor IS DISTINCT FROM current_setting('app.user_id', true)
     OR current_setting('app.role', true) NOT IN (
       'agency_owner', 'agency_admin', 'agency_operator', 'platform_admin'
     ) THEN
    RAISE EXCEPTION 'acknowledge_incident: actor is not authorized'
      USING ERRCODE = '42501';
  END IF;

  SELECT i.* INTO v_row
  FROM incidents i
  WHERE i.id = p_incident_id
    AND i."organizationId" = p_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident not found'
      USING ERRCODE = '02000';
  END IF;

  IF NOT app_user_can_access_client(v_row."organizationId", v_row."clientId") THEN
    RAISE EXCEPTION 'acknowledge_incident: tenant access denied'
      USING ERRCODE = '42501';
  END IF;

  -- Only open incidents can be acknowledged.
  IF v_row.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'only open incidents can be acknowledged, current status: %', v_row.status
      USING ERRCODE = '23505';
  END IF;

  -- Optional optimistic concurrency: expected_status
  IF p_expected_status IS NOT NULL AND v_row.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'incident status has changed, expected %', p_expected_status
      USING ERRCODE = '23505';
  END IF;

  UPDATE incidents i
  SET status = 'acknowledged',
      "acknowledgedAt" = now(),
      "acknowledgedBy" = p_actor,
      "updatedAt" = now()
  WHERE i.id = v_row.id;

  INSERT INTO incident_events (
    "organizationId", "clientId", "incidentId", event_type, actor, "correlationId"
  ) VALUES (
    v_row."organizationId", v_row."clientId", v_row.id,
    'acknowledged', p_actor, p_correlation_id
  );

  RETURN QUERY
  SELECT i.id, i.status, i."acknowledgedAt", i."acknowledgedBy", i."updatedAt"
  FROM incidents i
  WHERE i.id = v_row.id;
END
$$;

REVOKE EXECUTE ON FUNCTION acknowledge_incident(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION acknowledge_incident(uuid, uuid, text, text, text)
  TO leadops_runtime, leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 9. SECURITY DEFINER — resolve_incident
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_incident(
  p_incident_id uuid,
  p_org uuid,
  p_actor text,
  p_expected_status text,
  p_correlation_id text
) RETURNS TABLE(
  id uuid,
  status varchar,
  "resolvedAt" timestamptz,
  "resolvedBy" varchar,
  "updatedAt" timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_row incidents%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.user_id', true), '') IS NULL
     OR p_actor IS DISTINCT FROM current_setting('app.user_id', true)
     OR current_setting('app.role', true) NOT IN (
       'agency_owner', 'agency_admin', 'agency_operator', 'platform_admin'
     ) THEN
    RAISE EXCEPTION 'resolve_incident: actor is not authorized'
      USING ERRCODE = '42501';
  END IF;

  SELECT i.* INTO v_row
  FROM incidents i
  WHERE i.id = p_incident_id
    AND i."organizationId" = p_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident not found'
      USING ERRCODE = '02000';
  END IF;

  IF NOT app_user_can_access_client(v_row."organizationId", v_row."clientId") THEN
    RAISE EXCEPTION 'resolve_incident: tenant access denied'
      USING ERRCODE = '42501';
  END IF;

  IF v_row.status IS DISTINCT FROM 'open'
     AND v_row.status IS DISTINCT FROM 'acknowledged' THEN
    RAISE EXCEPTION 'only open or acknowledged incidents can be resolved, current status: %', v_row.status
      USING ERRCODE = '23505';
  END IF;

  IF p_expected_status IS NOT NULL AND v_row.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'incident status has changed, expected %', p_expected_status
      USING ERRCODE = '23505';
  END IF;

  UPDATE incidents i
  SET status = 'resolved',
      "resolvedAt" = now(),
      "resolvedBy" = p_actor,
      "updatedAt" = now()
  WHERE i.id = v_row.id;

  INSERT INTO incident_events (
    "organizationId", "clientId", "incidentId", event_type, actor, "correlationId"
  ) VALUES (
    v_row."organizationId", v_row."clientId", v_row.id,
    'resolved', p_actor, p_correlation_id
  );

  RETURN QUERY
  SELECT i.id, i.status, i."resolvedAt", i."resolvedBy", i."updatedAt"
  FROM incidents i
  WHERE i.id = v_row.id;
END
$$;

REVOKE EXECUTE ON FUNCTION resolve_incident(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_incident(uuid, uuid, text, text, text)
  TO leadops_runtime, leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 10. SECURITY DEFINER — create_report_snapshot (idempotent)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_report_snapshot_idempotent(
  p_org uuid,
  p_client uuid,
  p_integration_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_generation_version integer,
  p_metrics jsonb,
  p_correlation_id text DEFAULT NULL
) RETURNS TABLE(
  id uuid,
  "organizationId" uuid,
  "clientId" uuid,
  "periodStart" timestamptz,
  "periodEnd" timestamptz,
  "generationVersion" integer,
  metrics jsonb,
  "generatedAt" timestamptz,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_snapshot_id uuid;
  v_metric_key text;
BEGIN
  IF NOT app_machine_can_access(p_org, p_client, p_integration_id) THEN
    RAISE EXCEPTION 'report snapshot context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  IF p_period_start IS NULL OR p_period_end IS NULL THEN
    RAISE EXCEPTION 'period start and end are required'
      USING ERRCODE = '23514';
  END IF;

  IF p_period_start >= p_period_end THEN
    RAISE EXCEPTION 'periodStart must be before periodEnd'
      USING ERRCODE = '23514';
  END IF;

  IF p_generation_version < 1 THEN
    RAISE EXCEPTION 'generationVersion must be positive'
      USING ERRCODE = '23514';
  END IF;

  IF p_period_end IS DISTINCT FROM p_period_start + interval '7 days'
     OR p_period_start IS DISTINCT FROM
       (date_trunc('week', p_period_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'report period must be a complete UTC Monday week'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(p_metrics) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'metrics must be a JSON object'
      USING ERRCODE = '23514';
  END IF;

  FOREACH v_metric_key IN ARRAY ARRAY[
    'leadsReceived', 'qualificationRate', 'approvalConversion', 'appointments',
    'workflowSuccess', 'workflowFailure', 'openIncidents', 'resolvedIncidents'
  ] LOOP
    IF NOT (p_metrics ? v_metric_key)
       OR jsonb_typeof(p_metrics -> v_metric_key) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'metrics.% must be numeric', v_metric_key
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF (p_metrics ->> 'qualificationRate')::numeric NOT BETWEEN 0 AND 1
     OR (p_metrics ->> 'approvalConversion')::numeric NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'report rates must be between zero and one'
      USING ERRCODE = '23514';
  END IF;

  -- Validate integration binding.
  PERFORM 1
  FROM integrations i
  WHERE i.id = p_integration_id
    AND i."organizationId" = p_org
    AND i."clientId" = p_client
    AND i.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report snapshot integration binding is invalid'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO report_snapshots (
    "organizationId", "clientId", "integrationId",
    "periodStart", "periodEnd", "generationVersion",
    metrics, "correlationId"
  ) VALUES (
    p_org, p_client, p_integration_id,
    p_period_start, p_period_end, p_generation_version,
    p_metrics, p_correlation_id
  )
  ON CONFLICT ON CONSTRAINT report_snapshots_period_generation_unique
  DO NOTHING
  RETURNING report_snapshots.id INTO v_snapshot_id;

  IF v_snapshot_id IS NOT NULL THEN
    RETURN QUERY
    SELECT rs.id, rs."organizationId", rs."clientId",
           rs."periodStart", rs."periodEnd", rs."generationVersion",
           rs.metrics, rs."generatedAt", true
    FROM report_snapshots rs
    WHERE rs.id = v_snapshot_id;
  ELSE
    RETURN QUERY
    SELECT rs.id, rs."organizationId", rs."clientId",
           rs."periodStart", rs."periodEnd", rs."generationVersion",
           rs.metrics, rs."generatedAt", false
    FROM report_snapshots rs
    WHERE rs."organizationId" = p_org
      AND rs."clientId" = p_client
      AND rs."periodStart" = p_period_start
      AND rs."periodEnd" = p_period_end
      AND rs."generationVersion" = p_generation_version;
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION create_report_snapshot_idempotent(
  uuid, uuid, uuid, timestamptz, timestamptz, integer, jsonb, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_report_snapshot_idempotent(
  uuid, uuid, uuid, timestamptz, timestamptz, integer, jsonb, text
) TO leadops_worker, leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 11. Worker metric computation across every integration belonging to a client
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compute_weekly_report_metrics(
  p_org uuid,
  p_client uuid,
  p_integration_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
) RETURNS TABLE(
  "leadsReceived" integer,
  "qualifiedLeads" integer,
  "totalLeads" integer,
  approvals integer,
  "approvedDecisions" integer,
  "rejectedDecisions" integer,
  appointments integer,
  "workflowSuccess" integer,
  "workflowFailure" integer,
  "openIncidents" integer,
  "resolvedIncidents" integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_machine_can_access(p_org, p_client, p_integration_id) THEN
    RAISE EXCEPTION 'report metric context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM integrations i
  WHERE i.id = p_integration_id
    AND i."organizationId" = p_org
    AND i."clientId" = p_client
    AND i.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report metric integration binding is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF p_period_end IS DISTINCT FROM p_period_start + interval '7 days'
     OR p_period_start IS DISTINCT FROM
       (date_trunc('week', p_period_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'report period must be a complete UTC Monday week'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  WITH lead_stats AS (
    SELECT
      count(*)::integer AS leads_received,
      count(*) FILTER (
        WHERE l.status IN ('qualified', 'approved', 'converted')
      )::integer AS qualified_leads
    FROM leads l
    WHERE l."organizationId" = p_org
      AND l."clientId" = p_client
      AND COALESCE(l."receivedAt", l."createdAt") >= p_period_start
      AND COALESCE(l."receivedAt", l."createdAt") < p_period_end
  ),
  appointment_stats AS (
    SELECT count(*)::integer AS appointments
    FROM business_events e
    WHERE e."organizationId" = p_org
      AND e."clientId" = p_client
      AND e."eventType" = 'appointment.booked'
      AND e."receivedAt" >= p_period_start
      AND e."receivedAt" < p_period_end
  ),
  approval_stats AS (
    SELECT
      count(*) FILTER (WHERE a.status IN ('approved', 'rejected'))::integer AS approvals,
      count(*) FILTER (WHERE a.status = 'approved')::integer AS approved,
      count(*) FILTER (WHERE a.status = 'rejected')::integer AS rejected
    FROM approvals a
    WHERE a."organizationId" = p_org
      AND a."clientId" = p_client
      AND a.decided_at >= p_period_start
      AND a.decided_at < p_period_end
  ),
  workflow_stats AS (
    SELECT
      count(*) FILTER (
        WHERE wr.status = 'succeeded'
          AND wr."succeededAt" >= p_period_start
          AND wr."succeededAt" < p_period_end
      )::integer AS succeeded,
      count(*) FILTER (
        WHERE wr.status = 'failed'
          AND wr."failedAt" >= p_period_start
          AND wr."failedAt" < p_period_end
      )::integer AS failed
    FROM workflow_runs wr
    WHERE wr."organizationId" = p_org
      AND wr."clientId" = p_client
  ),
  incident_at_end AS (
    SELECT DISTINCT ON (e."incidentId") e."incidentId", e.event_type
    FROM incident_events e
    WHERE e."organizationId" = p_org
      AND e."clientId" = p_client
      AND e."createdAt" < p_period_end
    ORDER BY e."incidentId", e."createdAt" DESC, e.id DESC
  ),
  incident_stats AS (
    SELECT
      (SELECT count(*)::integer FROM incident_at_end WHERE event_type <> 'resolved') AS open_count,
      (SELECT count(DISTINCT e."incidentId")::integer
       FROM incident_events e
       WHERE e."organizationId" = p_org
         AND e."clientId" = p_client
         AND e.event_type = 'resolved'
         AND e."createdAt" >= p_period_start
         AND e."createdAt" < p_period_end) AS resolved_count
  )
  SELECT
    ls.leads_received,
    ls.qualified_leads,
    ls.leads_received,
    aps.approvals,
    aps.approved,
    aps.rejected,
    appts.appointments,
    wfs.succeeded,
    wfs.failed,
    ins.open_count,
    ins.resolved_count
  FROM lead_stats ls
  CROSS JOIN appointment_stats appts
  CROSS JOIN approval_stats aps
  CROSS JOIN workflow_stats wfs
  CROSS JOIN incident_stats ins;
END
$$;

REVOKE EXECUTE ON FUNCTION compute_weekly_report_metrics(
  uuid, uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION compute_weekly_report_metrics(
  uuid, uuid, uuid, timestamptz, timestamptz
) TO leadops_worker, leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 12. Worker discovery — list_due_weekly_report_clients
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_due_weekly_report_clients(
  p_batch_size integer,
  p_generation_version integer
) RETURNS TABLE(
  "organizationId" uuid,
  "clientId" uuid,
  "integrationId" uuid,
  "periodStart" timestamptz,
  "periodEnd" timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_week_start timestamptz;
  v_week_end timestamptz;
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 1000';
  END IF;

  IF p_generation_version < 1 THEN
    RAISE EXCEPTION 'generationVersion must be positive';
  END IF;

  -- Calculate the most recent completed UTC week (Monday 00:00 to next Monday 00:00).
  v_week_end := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_week_start := v_week_end - interval '7 days';

  RETURN QUERY
  SELECT due."organizationId", due."clientId", due."integrationId",
         v_week_start, v_week_end
  FROM (
    SELECT DISTINCT ON (i."organizationId", i."clientId")
           i."organizationId", i."clientId", i.id AS "integrationId"
    FROM integrations i
    JOIN clients c
      ON c.id = i."clientId"
     AND c."organizationId" = i."organizationId"
     AND c.status = 'active'
    WHERE i.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM report_snapshots rs
        WHERE rs."organizationId" = i."organizationId"
          AND rs."clientId" = i."clientId"
          AND rs."periodStart" = v_week_start
          AND rs."periodEnd" = v_week_end
          AND rs."generationVersion" = p_generation_version
      )
    ORDER BY i."organizationId", i."clientId", i.id
  ) due
  ORDER BY due."organizationId", due."clientId"
  LIMIT p_batch_size;
END
$$;

REVOKE EXECUTE ON FUNCTION list_due_weekly_report_clients(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_weekly_report_clients(integer, integer)
  TO leadops_worker, leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 13. Updated worker grants (additive to Phase 6A)
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
  -- Phase 6B: worker has limited direct table access; most ops via SECURITY DEFINER.
  EXECUTE format('GRANT SELECT ON incidents TO %I', _role);
  EXECUTE format('GRANT SELECT ON incident_events TO %I', _role);
  EXECUTE format('GRANT SELECT ON report_snapshots TO %I', _role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON incidents FROM %I', _role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON incident_events FROM %I', _role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON report_snapshots FROM %I', _role);
  -- Cross-integration metric aggregation is performed only by the hardened
  -- compute_weekly_report_metrics SECURITY DEFINER function.
END
$$;

SELECT app_grant_worker('leadops_worker');
SELECT app_grant_worker('leadops_worker_test');
REVOKE EXECUTE ON FUNCTION app_grant_worker(text) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 14. Updated runtime grants (additive)
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

  -- Phase 6B: runtime (user-facing) access.
  EXECUTE format('GRANT SELECT ON incidents TO %I', _role);
  EXECUTE format('GRANT SELECT ON incident_events TO %I', _role);
  EXECUTE format('GRANT SELECT ON report_snapshots TO %I', _role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON incidents FROM %I', _role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON incident_events FROM %I', _role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON report_snapshots FROM %I', _role);

  EXECUTE format('REVOKE UPDATE ("platform_admin") ON users FROM %I', _role);
END
$$;

SELECT app_grant_runtime('leadops_runtime');
SELECT app_grant_runtime('leadops_runtime_test');
REVOKE EXECUTE ON FUNCTION app_grant_runtime(text) FROM PUBLIC;
