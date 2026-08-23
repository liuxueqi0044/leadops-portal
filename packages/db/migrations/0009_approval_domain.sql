-- 0009_approval_domain.sql — Phase 5: approvals, tokens, deliveries, history
--
-- approvals           — immutable snapshot, strict state machine, versioned
-- approval_tokens     — SHA-256 hashed one-time tokens, TTL, usage tracking
-- approval_deliveries — outbox-style callback delivery with idempotency key
-- approval_history    — append-only audit of every state change
--
-- All tables have FORCE RLS, composite FKs, and organization/client binding.
-- SECURITY DEFINER functions repeat tenant authorization internally.
-- ============================================================================

ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS callback_url text;

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  "integrationId" uuid NOT NULL,
  "leadId" uuid,
  correlation_id text,
  request_version text,
  idempotency_key text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  snapshot jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  requested_by varchar(100),
  decided_by varchar(100),
  decided_at timestamptz,
  decision_reason text,
  metadata jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("clientId", "organizationId") REFERENCES clients(id, "organizationId"),
  FOREIGN KEY ("integrationId", "organizationId", "clientId")
    REFERENCES integrations(id, "organizationId", "clientId"),
  UNIQUE (id, "organizationId"),
  UNIQUE (id, "organizationId", "clientId"),
  UNIQUE ("organizationId", "clientId", idempotency_key)
);

CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals ("organizationId", "clientId", status);
CREATE INDEX IF NOT EXISTS approvals_expires_idx ON approvals (status, expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS approval_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "approvalId" uuid NOT NULL,
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  token_hash text NOT NULL,
  purpose varchar(50) NOT NULL DEFAULT 'public_decision',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("approvalId", "organizationId", "clientId")
    REFERENCES approvals(id, "organizationId", "clientId"),
  UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS approval_tokens_hash_idx ON approval_tokens (token_hash);
CREATE INDEX IF NOT EXISTS approval_tokens_approval_idx ON approval_tokens ("approvalId");

CREATE TABLE IF NOT EXISTS approval_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "approvalId" uuid NOT NULL,
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  "integrationId" uuid NOT NULL,
  message_type varchar(100) NOT NULL DEFAULT 'approval.completed',
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  last_error text,
  "nextAttemptAt" timestamptz DEFAULT now(),
  "lockedAt" timestamptz,
  "lockedBy" varchar(200),
  "deliveredAt" timestamptz,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("approvalId", "organizationId", "clientId")
    REFERENCES approvals(id, "organizationId", "clientId"),
  FOREIGN KEY ("integrationId", "organizationId", "clientId")
    REFERENCES integrations(id, "organizationId", "clientId"),
  UNIQUE ("integrationId", idempotency_key)
);

CREATE INDEX IF NOT EXISTS approval_deliveries_status_idx
  ON approval_deliveries (status, "nextAttemptAt" ASC NULLS FIRST)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS approval_deliveries_idem_idx
  ON approval_deliveries ("integrationId", idempotency_key);

CREATE TABLE IF NOT EXISTS approval_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "approvalId" uuid NOT NULL,
  "organizationId" uuid NOT NULL REFERENCES organizations(id),
  "clientId" uuid NOT NULL,
  previous_status varchar(20),
  new_status varchar(20) NOT NULL,
  "command" varchar(50) NOT NULL,
  "performedBy" varchar(100) NOT NULL DEFAULT 'system',
  metadata jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY ("approvalId", "organizationId", "clientId")
    REFERENCES approvals(id, "organizationId", "clientId")
);

CREATE INDEX IF NOT EXISTS approval_history_approval_idx ON approval_history ("approvalId", "createdAt");

-- ----------------------------------------------------------------------------
-- 2. RLS policies — approvals
-- ----------------------------------------------------------------------------
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approvals_select ON approvals;
CREATE POLICY approvals_select ON approvals FOR SELECT
  USING (
    (
      app_ctx_valid()
      AND app_user_can_access_client("organizationId", "clientId")
    )
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

DROP POLICY IF EXISTS approvals_insert ON approvals;
CREATE POLICY approvals_insert ON approvals FOR INSERT
  WITH CHECK (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

DROP POLICY IF EXISTS approvals_update ON approvals;
CREATE POLICY approvals_update ON approvals FOR UPDATE
  USING (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

-- ----------------------------------------------------------------------------
-- 3. RLS policies — approval_tokens
-- ----------------------------------------------------------------------------
ALTER TABLE approval_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approval_tokens_select ON approval_tokens;
CREATE POLICY approval_tokens_select ON approval_tokens FOR SELECT
  USING (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

DROP POLICY IF EXISTS approval_tokens_insert ON approval_tokens;
CREATE POLICY approval_tokens_insert ON approval_tokens FOR INSERT
  WITH CHECK (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

DROP POLICY IF EXISTS approval_tokens_update ON approval_tokens;
CREATE POLICY approval_tokens_update ON approval_tokens FOR UPDATE
  USING (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

-- ----------------------------------------------------------------------------
-- 4. RLS policies — approval_deliveries
-- ----------------------------------------------------------------------------
ALTER TABLE approval_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approval_deliveries_select ON approval_deliveries;
CREATE POLICY approval_deliveries_select ON approval_deliveries FOR SELECT
  USING (
    (
      app_ctx_valid()
      AND app_user_can_access_client("organizationId", "clientId")
    )
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

DROP POLICY IF EXISTS approval_deliveries_insert ON approval_deliveries;
CREATE POLICY approval_deliveries_insert ON approval_deliveries FOR INSERT
  WITH CHECK (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

DROP POLICY IF EXISTS approval_deliveries_update ON approval_deliveries;
CREATE POLICY approval_deliveries_update ON approval_deliveries FOR UPDATE
  USING (
    (
      app_ctx_valid()
      AND app_user_can_access_client("organizationId", "clientId")
    )
    OR app_machine_can_access("organizationId", "clientId", "integrationId")
  );

-- ----------------------------------------------------------------------------
-- 5. RLS policies — approval_history (append-only for runtime roles)
-- ----------------------------------------------------------------------------
ALTER TABLE approval_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approval_history_select ON approval_history;
CREATE POLICY approval_history_select ON approval_history FOR SELECT
  USING (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

DROP POLICY IF EXISTS approval_history_insert ON approval_history;
CREATE POLICY approval_history_insert ON approval_history FOR INSERT
  WITH CHECK (
    app_ctx_valid()
    AND app_user_can_access_client("organizationId", "clientId")
  );

-- ----------------------------------------------------------------------------
-- 6. SECURITY DEFINER — idempotent approval creation
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_approval_transactional(
  p_org uuid,
  p_client uuid,
  p_lead_id uuid,
  p_correlation text,
  p_request_version text,
  p_snapshot jsonb,
  p_expires_at timestamptz,
  p_requested_by varchar,
  p_integration_id uuid,
  p_idempotency_key text
) RETURNS TABLE(
  aid uuid,
  oid uuid,
  cid uuid,
  st varchar,
  ver integer,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_approval_id uuid;
BEGIN
  IF NOT (
    app_user_can_access_client(p_org, p_client)
    OR app_machine_can_access_tenant(p_org, p_client)
  ) THEN
    RAISE EXCEPTION 'approval tenant context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'approval idempotency key is required'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM integrations i
  WHERE i.id = p_integration_id
    AND i."organizationId" = p_org
    AND i."clientId" = p_client
    AND i.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval integration binding is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF p_lead_id IS NOT NULL THEN
    PERFORM 1
    FROM leads l
    WHERE l.id = p_lead_id
      AND l."organizationId" = p_org
      AND l."clientId" = p_client;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approval lead binding is invalid'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO approvals (
    "organizationId", "clientId", "integrationId", "leadId",
    correlation_id, request_version, idempotency_key,
    status, snapshot, expires_at, version,
    requested_by
  ) VALUES (
    p_org, p_client, p_integration_id, p_lead_id,
    p_correlation, p_request_version, p_idempotency_key,
    'pending', p_snapshot, p_expires_at, 1,
    p_requested_by
  )
  ON CONFLICT ("organizationId", "clientId", idempotency_key)
    DO NOTHING
  RETURNING id INTO v_approval_id;

  IF NOT FOUND THEN
    SELECT a.id, a."organizationId", a."clientId", a.status, a.version, false
    INTO aid, oid, cid, st, ver, created
    FROM approvals a
    WHERE a."organizationId" = p_org
      AND a."clientId" = p_client
      AND a.idempotency_key = p_idempotency_key
    LIMIT 1;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO approval_history (
    "approvalId", "organizationId", "clientId",
    previous_status, new_status, "command", "performedBy"
  ) VALUES (
    v_approval_id, p_org, p_client,
    NULL, 'pending', 'approval.requested', p_requested_by
  );

  SELECT a.id, a."organizationId", a."clientId", a.status, a.version, true
  INTO aid, oid, cid, st, ver, created
  FROM approvals a
  WHERE a.id = v_approval_id;

  RETURN NEXT;
END
$$;

REVOKE EXECUTE ON FUNCTION create_approval_transactional(uuid, uuid, uuid, text, text, jsonb, timestamptz, varchar, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_approval_transactional(uuid, uuid, uuid, text, text, jsonb, timestamptz, varchar, uuid, text) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION create_approval_transactional(uuid, uuid, uuid, text, text, jsonb, timestamptz, varchar, uuid, text) TO leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 7. SECURITY DEFINER — atomic approval decision (version-conditional)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION decide_approval_atomic(
  p_approval_id uuid,
  p_org uuid,
  p_client uuid,
  p_decision varchar,
  p_decided_by varchar,
  p_decision_reason text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
) RETURNS TABLE(
  aid uuid,
  oid uuid,
  cid uuid,
  st varchar,
  ver integer,
  decided boolean,
  delivery_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_current_status varchar;
  v_current_version integer;
  v_updated integer;
  v_integration_id uuid;
  v_lead_id uuid;
  v_decided_at timestamptz := now();
BEGIN
  IF NOT (
    app_user_can_access_client(p_org, p_client)
    OR app_machine_can_access_tenant(p_org, p_client)
  ) THEN
    RAISE EXCEPTION 'approval tenant context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'decision must be approved or rejected'
      USING ERRCODE = '23514';
  END IF;

  SELECT a.status, a.version, a."integrationId", a."leadId"
  INTO v_current_status, v_current_version, v_integration_id, v_lead_id
  FROM approvals a
  WHERE a.id = p_approval_id
    AND a."organizationId" = p_org
    AND a."clientId" = p_client
  FOR UPDATE;

  IF NOT FOUND THEN
    st := NULL;
    decided := false;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_current_status != 'pending' THEN
    aid := p_approval_id;
    oid := p_org;
    cid := p_client;
    st := v_current_status;
    ver := v_current_version;
    decided := false;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_expected_version IS NOT NULL AND v_current_version != p_expected_version THEN
    aid := p_approval_id;
    oid := p_org;
    cid := p_client;
    st := v_current_status;
    ver := v_current_version;
    decided := false;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE approvals a
  SET status = p_decision,
      version = a.version + 1,
      decided_by = p_decided_by,
      decided_at = v_decided_at,
      decision_reason = p_decision_reason,
      "updatedAt" = now()
  WHERE a.id = p_approval_id
    AND a."organizationId" = p_org
    AND a."clientId" = p_client
    AND a.status = 'pending'
      AND a.version = v_current_version;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 1 THEN
    INSERT INTO approval_history (
      "approvalId", "organizationId", "clientId",
      previous_status, new_status, "command", "performedBy"
    ) VALUES (
      p_approval_id, p_org, p_client,
      v_current_status, p_decision, 'decide', p_decided_by
    );

    INSERT INTO approval_deliveries (
      "approvalId", "organizationId", "clientId", "integrationId",
      message_type, status, payload, idempotency_key
    ) VALUES (
      p_approval_id, p_org, p_client, v_integration_id,
      'approval.completed', 'pending',
      jsonb_strip_nulls(jsonb_build_object(
        'eventType', 'approval.completed',
        'approvalId', p_approval_id,
        'leadId', v_lead_id,
        'decision', p_decision,
        'status', p_decision,
        'decidedBy', p_decided_by,
        'decidedAt', v_decided_at,
        'decisionReason', p_decision_reason,
        'version', v_current_version + 1
      )),
      format('approval-completed-%s-%s', p_approval_id, v_current_version + 1)
    )
    RETURNING id INTO delivery_id;
  END IF;

  SELECT a.id, a."organizationId", a."clientId", a.status, a.version
  INTO aid, oid, cid, st, ver
  FROM approvals a
  WHERE a.id = p_approval_id;

  decided := (v_updated > 0);
  RETURN NEXT;
END
$$;

REVOKE EXECUTE ON FUNCTION decide_approval_atomic(uuid, uuid, uuid, varchar, varchar, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decide_approval_atomic(uuid, uuid, uuid, varchar, varchar, text, integer) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION decide_approval_atomic(uuid, uuid, uuid, varchar, varchar, text, integer) TO leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 8. SECURITY DEFINER — approval token insertion (hash only, no plaintext)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION insert_approval_token_safe(
  p_approval_id uuid,
  p_org uuid,
  p_client uuid,
  p_token_hash text,
  p_purpose varchar,
  p_expires_at timestamptz
) RETURNS TABLE(
  tid uuid,
  tok_hash text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (
    app_user_can_access_client(p_org, p_client)
    OR app_machine_can_access_tenant(p_org, p_client)
  ) THEN
    RAISE EXCEPTION 'approval token insert not authorized'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM approvals a
  WHERE a.id = p_approval_id
    AND a."organizationId" = p_org
    AND a."clientId" = p_client
    AND a.status = 'pending'
    AND p_expires_at <= a.expires_at
    AND (
      app_user_can_access_client(p_org, p_client)
      OR app_machine_can_access(p_org, p_client, a."integrationId")
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval token binding or expiry is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  INSERT INTO approval_tokens (
    "approvalId", "organizationId", "clientId",
    token_hash, purpose, expires_at
  ) VALUES (
    p_approval_id, p_org, p_client,
    p_token_hash, p_purpose, p_expires_at
  )
  ON CONFLICT (token_hash) DO NOTHING
  RETURNING id, token_hash;
END
$$;

REVOKE EXECUTE ON FUNCTION insert_approval_token_safe(uuid, uuid, uuid, text, varchar, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION insert_approval_token_safe(uuid, uuid, uuid, text, varchar, timestamptz) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION insert_approval_token_safe(uuid, uuid, uuid, text, varchar, timestamptz) TO leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 9. SECURITY DEFINER — consume token and atomically decide approval
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consume_approval_token_and_decide(
  p_token_hash text,
  p_decision varchar,
  p_decided_by varchar,
  p_decision_reason text DEFAULT NULL
) RETURNS TABLE(
  approval_id uuid,
  org_id uuid,
  client_id uuid,
  approval_status varchar,
  approval_version integer,
  token_status varchar,
  decided boolean,
  delivery_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_token_id uuid;
  v_approval_id uuid;
  v_org uuid;
  v_client uuid;
  v_token_status varchar := 'not_found';
  v_approval_status varchar;
  v_approval_version integer;
  v_updated integer := 0;
  v_integration_id uuid;
  v_lead_id uuid;
  v_decided_at timestamptz := now();
BEGIN
  SELECT t.id, t."approvalId", t."organizationId", t."clientId",
         CASE
           WHEN t.revoked_at IS NOT NULL THEN 'revoked'
           WHEN t.used_at IS NOT NULL THEN 'already_used'
           WHEN t.expires_at < now() THEN 'expired'
           ELSE 'valid'
         END
  INTO v_token_id, v_approval_id, v_org, v_client, v_token_status
  FROM approval_tokens t
  WHERE t.token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    token_status := 'not_found';
    decided := false;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_token_status != 'valid' THEN
    approval_id := v_approval_id;
    org_id := v_org;
    client_id := v_client;
    token_status := v_token_status;
    decided := false;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_decision != 'approved' AND p_decision != 'rejected' THEN
    RAISE EXCEPTION 'decision must be approved or rejected'
      USING ERRCODE = '23514';
  END IF;

  SELECT a.status, a.version, a."integrationId", a."leadId"
  INTO v_approval_status, v_approval_version, v_integration_id, v_lead_id
  FROM approvals a
  WHERE a.id = v_approval_id
    AND a."organizationId" = v_org
    AND a."clientId" = v_client
  FOR UPDATE;

  IF NOT FOUND THEN
    token_status := 'approval_not_found';
    decided := false;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_approval_status != 'pending' THEN
    approval_id := v_approval_id;
    org_id := v_org;
    client_id := v_client;
    approval_status := v_approval_status;
    approval_version := v_approval_version;
    token_status := 'valid';
    decided := false;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE approval_tokens
  SET used_at = now()
  WHERE id = v_token_id;

  UPDATE approvals
  SET status = p_decision,
      version = version + 1,
      decided_by = p_decided_by,
      decided_at = v_decided_at,
      decision_reason = p_decision_reason,
      "updatedAt" = now()
  WHERE id = v_approval_id
    AND status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 1 THEN
    INSERT INTO approval_history (
      "approvalId", "organizationId", "clientId",
      previous_status, new_status, "command", "performedBy"
    ) VALUES (
      v_approval_id, v_org, v_client,
      'pending', p_decision, 'decide_public', p_decided_by
    );

    SELECT a.status, a.version INTO v_approval_status, v_approval_version
    FROM approvals a
    WHERE a.id = v_approval_id;

    INSERT INTO approval_deliveries (
      "approvalId", "organizationId", "clientId", "integrationId",
      message_type, status, payload, idempotency_key
    ) VALUES (
      v_approval_id, v_org, v_client, v_integration_id,
      'approval.completed', 'pending',
      jsonb_strip_nulls(jsonb_build_object(
        'eventType', 'approval.completed',
        'approvalId', v_approval_id,
        'leadId', v_lead_id,
        'decision', p_decision,
        'status', p_decision,
        'decidedBy', p_decided_by,
        'decidedAt', v_decided_at,
        'decisionReason', p_decision_reason,
        'version', v_approval_version
      )),
      format('approval-completed-%s-%s', v_approval_id, v_approval_version)
    )
    RETURNING id INTO delivery_id;
  END IF;

  approval_id := v_approval_id;
  org_id := v_org;
  client_id := v_client;
  approval_status := v_approval_status;
  approval_version := v_approval_version;
  token_status := CASE WHEN v_updated > 0 THEN 'used' ELSE v_token_status END;
  decided := (v_updated > 0);
  RETURN NEXT;
END
$$;

REVOKE EXECUTE ON FUNCTION consume_approval_token_and_decide(text, varchar, varchar, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_approval_token_and_decide(text, varchar, varchar, text) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION consume_approval_token_and_decide(text, varchar, varchar, text) TO leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 10. SECURITY DEFINER — revoke approval token
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION revoke_approval_token_safe(
  p_token_hash text,
  p_org uuid,
  p_client uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  rows_updated integer;
BEGIN
  IF NOT app_user_can_access_client(p_org, p_client) THEN
    RAISE EXCEPTION 'approval token revoke not authorized'
      USING ERRCODE = '42501';
  END IF;

  UPDATE approval_tokens t
  SET revoked_at = now()
  FROM approvals a
  WHERE t.token_hash = p_token_hash
    AND t."approvalId" = a.id
    AND a."organizationId" = p_org
    AND a."clientId" = p_client
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION revoke_approval_token_safe(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_approval_token_safe(text, uuid, uuid) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION revoke_approval_token_safe(text, uuid, uuid) TO leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 11. SECURITY DEFINER — expire pending approvals
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION expire_pending_approvals(
  p_org uuid,
  p_client uuid
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
  IF NOT (
    app_user_can_access_client(p_org, p_client)
    OR app_machine_can_access_tenant(p_org, p_client)
  ) THEN
    RAISE EXCEPTION 'approval expire context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  FOR rec IN (
    SELECT a.id, a."integrationId", a."leadId", a.version
    FROM approvals a
    WHERE a."organizationId" = p_org
      AND a."clientId" = p_client
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
        rec.id, p_org, p_client, rec."integrationId",
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

REVOKE EXECUTE ON FUNCTION expire_pending_approvals(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_pending_approvals(uuid, uuid) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION expire_pending_approvals(uuid, uuid) TO leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 12. SECURITY DEFINER — lookup approval by token hash (for public endpoint)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lookup_approval_by_token_hash(
  p_token_hash text
) RETURNS TABLE(
  approval_id uuid,
  org_id uuid,
  client_id uuid,
  approval_status varchar,
  snapshot jsonb,
  token_status varchar,
  token_expires_at timestamptz
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_status varchar;
BEGIN
  SELECT
    CASE
      WHEN t.revoked_at IS NOT NULL THEN 'revoked'
      WHEN t.used_at IS NOT NULL THEN 'already_used'
      WHEN t.expires_at < now() THEN 'expired'
      ELSE 'valid'
    END
  INTO v_status
  FROM approval_tokens t
  WHERE t.token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT a.id, a."organizationId", a."clientId", a.status, a.snapshot,
         v_status, t.expires_at
  FROM approval_tokens t
  JOIN approvals a ON a.id = t."approvalId"
    AND a."organizationId" = t."organizationId"
    AND a."clientId" = t."clientId"
  WHERE t.token_hash = p_token_hash
  LIMIT 1;
END
$$;

REVOKE EXECUTE ON FUNCTION lookup_approval_by_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_approval_by_token_hash(text) TO leadops_runtime;
GRANT EXECUTE ON FUNCTION lookup_approval_by_token_hash(text) TO leadops_runtime_test;

-- ----------------------------------------------------------------------------
-- 13. SECURITY DEFINER — claim approval delivery items (worker polling)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_approval_delivery_items(
  p_worker_id text,
  p_batch_size integer DEFAULT 10
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
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) = 0 THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  IF p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 1000';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT d.id
    FROM approval_deliveries d
    WHERE (
      d.status = 'pending'
      AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= now())
    ) OR (
      d.status = 'processing'
      AND d."lockedAt" < now() - interval '5 minutes'
    )
    ORDER BY d."nextAttemptAt" ASC NULLS FIRST, d."createdAt", d.id
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE approval_deliveries d
    SET status = 'processing',
        attempt_count = d.attempt_count + 1,
        "lockedAt" = now(),
        "lockedBy" = p_worker_id
    FROM candidates c
    WHERE d.id = c.id
    RETURNING d.*
  )
  SELECT c.id, c."approvalId", c."organizationId", c."clientId",
         c."integrationId", c.message_type, c.status,
         c.attempt_count, c.max_attempts, c.last_error, c.payload,
         c.idempotency_key, c."createdAt", i.callback_url, secret.encrypted_secret
  FROM claimed c
  JOIN integrations i
    ON i.id = c."integrationId"
   AND i."organizationId" = c."organizationId"
   AND i."clientId" = c."clientId"
  LEFT JOIN LATERAL (
    SELECT s.encrypted_secret
    FROM integration_secrets s
    WHERE s."integrationId" = c."integrationId"
      AND s."organizationId" = c."organizationId"
      AND (s."revokedAt" IS NULL OR s."revokedAt" > now())
    ORDER BY s.version DESC
    LIMIT 1
  ) secret ON true;
END
$$;

REVOKE EXECUTE ON FUNCTION claim_approval_delivery_items(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_approval_delivery_items(text, integer) TO leadops_worker;
GRANT EXECUTE ON FUNCTION claim_approval_delivery_items(text, integer) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 14. SECURITY DEFINER — mark approval delivery delivered
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_approval_delivery_delivered(
  p_delivery_id uuid,
  p_worker_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  rows_updated integer;
BEGIN
  UPDATE approval_deliveries
  SET status = 'delivered',
      "deliveredAt" = now(),
      "lockedAt" = NULL,
      "lockedBy" = NULL,
      "nextAttemptAt" = NULL,
      last_error = NULL
  WHERE id = p_delivery_id
    AND status = 'processing'
    AND "lockedBy" = p_worker_id;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION mark_approval_delivery_delivered(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_approval_delivery_delivered(uuid, text) TO leadops_worker;
GRANT EXECUTE ON FUNCTION mark_approval_delivery_delivered(uuid, text) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 15. SECURITY DEFINER — mark approval delivery failed with backoff
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_approval_delivery_failed(
  p_delivery_id uuid,
  p_worker_id text,
  p_error text,
  p_retryable boolean
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  rows_updated integer;
BEGIN
  UPDATE approval_deliveries
  SET status = CASE
        WHEN NOT p_retryable OR attempt_count >= max_attempts THEN 'dead_letter'
        ELSE 'pending'
      END,
      last_error = p_error,
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

REVOKE EXECUTE ON FUNCTION mark_approval_delivery_failed(uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_approval_delivery_failed(uuid, text, text, boolean) TO leadops_worker;
GRANT EXECUTE ON FUNCTION mark_approval_delivery_failed(uuid, text, text, boolean) TO leadops_worker_test;

-- ----------------------------------------------------------------------------
-- 16. Updated grants to runtime roles
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

  -- Phase 5 tables
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON approvals FROM %I', _role);
  EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON approval_tokens FROM %I', _role);
  EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON approval_deliveries FROM %I', _role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON approval_history FROM %I', _role);
  EXECUTE format('GRANT SELECT ON approvals TO %I', _role);
  EXECUTE format('GRANT SELECT ON approval_history TO %I', _role);

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
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), _role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', _role);
  EXECUTE format('GRANT SELECT ON business_events TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workflows TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workflow_runs TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON outbox TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON leads TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON lead_status_history TO %I', _role);
  EXECUTE format('GRANT SELECT, INSERT ON ai_runs TO %I', _role);
  EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON approval_deliveries FROM %I', _role);
  EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON approvals FROM %I', _role);
END
$$;

SELECT app_grant_worker('leadops_worker');
SELECT app_grant_worker('leadops_worker_test');
REVOKE EXECUTE ON FUNCTION app_grant_worker(text) FROM PUBLIC;
