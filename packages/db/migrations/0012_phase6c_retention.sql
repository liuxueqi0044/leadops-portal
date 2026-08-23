-- 0012_phase6c_retention.sql — Phase 6C: Data retention (prune non-audit data)
-- ============================================================================
-- SECURITY DEFINER function for pruning non-audit tables.
-- Uses a fixed whitelist; caller cannot pass arbitrary table names or SQL.
-- Default dryRun=true; concurrent execution protected by advisory lock.
--
-- Whitelist (tables safe to prune):
--   sessions          — expired > 90 days past expiration
--   verifications     — expired > 90 days past expiration
--   outbox            — terminal-state (delivered, dead_letter) > 30 days
--   email_deliveries  — terminal-state (sent, permanent_failure) > 90 days
--   approval_deliveries — terminal-state (delivered, dead_letter) > 90 days
--   pgboss.archive    — archived jobs > 30 days
--
-- Protected tables (NEVER pruned by this function):
--   business_events, audit_logs, approval_history, approval_tokens,
--   incidents, incident_events, report_snapshots, ai_runs,
--   organizations, users, integrations, integration_secrets,
--   workflows, workflow_runs, leads, lead_status_history,
--   approvals, clients, client_members, client_assignments,
--   accounts, organization_members, invitations,
--   pgboss.job, pgboss.schedule, pgboss.subscription, pgboss.cron,
--   schema_migrations
--
-- This migration does NOT replace app_grant_worker.
-- It ONLY adds the prune_non_audit_data SECURITY DEFINER function
-- and grants EXECUTE to worker roles.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Core prune function (SECURITY DEFINER, system-scoped)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prune_non_audit_data(
  dry_run boolean DEFAULT true
)
RETURNS TABLE(
  table_name text,
  candidate_count bigint,
  deleted_count bigint
)
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
  _lock_id bigint := 927846531;  -- stable transaction lock for concurrent safety
  _candidate bigint;
  _deleted bigint;
BEGIN
  -- A transaction-scoped lock is released on success and on every error path.
  -- Concurrent callers wait, then re-evaluate the same fixed predicates.
  PERFORM pg_advisory_xact_lock(_lock_id);

  -- 1) Expired sessions > 90 days past expiration
  SELECT count(*) INTO _candidate
    FROM sessions
   WHERE "expiresAt" < now() - interval '90 days';

  table_name := 'sessions';
  candidate_count := _candidate;
  deleted_count := 0;

  IF NOT dry_run AND _candidate > 0 THEN
    DELETE FROM sessions
     WHERE "expiresAt" < now() - interval '90 days';
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    deleted_count := _deleted;
  END IF;
  IF _candidate > 0 THEN
    RETURN NEXT;
  END IF;

  -- 2) Expired verifications > 90 days past expiration
  SELECT count(*) INTO _candidate
    FROM verifications
   WHERE "expiresAt" < now() - interval '90 days';

  table_name := 'verifications';
  candidate_count := _candidate;
  deleted_count := 0;

  IF NOT dry_run AND _candidate > 0 THEN
    DELETE FROM verifications
     WHERE "expiresAt" < now() - interval '90 days';
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    deleted_count := _deleted;
  END IF;
  IF _candidate > 0 THEN
    RETURN NEXT;
  END IF;

  -- 3) Terminal-state outbox items > 30 days
  SELECT count(*) INTO _candidate
    FROM outbox
   WHERE status IN ('delivered', 'dead_letter')
     AND COALESCE("deliveredAt", "createdAt") < now() - interval '30 days';

  table_name := 'outbox';
  candidate_count := _candidate;
  deleted_count := 0;

  IF NOT dry_run AND _candidate > 0 THEN
    DELETE FROM outbox
     WHERE status IN ('delivered', 'dead_letter')
       AND COALESCE("deliveredAt", "createdAt") < now() - interval '30 days';
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    deleted_count := _deleted;
  END IF;
  IF _candidate > 0 THEN
    RETURN NEXT;
  END IF;

  -- 4) Terminal-state email deliveries > 90 days
  SELECT count(*) INTO _candidate
    FROM email_deliveries
   WHERE status IN ('sent', 'permanent_failure')
     AND "createdAt" < now() - interval '90 days';

  table_name := 'email_deliveries';
  candidate_count := _candidate;
  deleted_count := 0;

  IF NOT dry_run AND _candidate > 0 THEN
    DELETE FROM email_deliveries
     WHERE status IN ('sent', 'permanent_failure')
       AND "createdAt" < now() - interval '90 days';
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    deleted_count := _deleted;
  END IF;
  IF _candidate > 0 THEN
    RETURN NEXT;
  END IF;

  -- 5) Terminal-state approval deliveries > 90 days
  SELECT count(*) INTO _candidate
    FROM approval_deliveries
   WHERE status IN ('delivered', 'dead_letter')
     AND "createdAt" < now() - interval '90 days';

  table_name := 'approval_deliveries';
  candidate_count := _candidate;
  deleted_count := 0;

  IF NOT dry_run AND _candidate > 0 THEN
    DELETE FROM approval_deliveries
     WHERE status IN ('delivered', 'dead_letter')
       AND "createdAt" < now() - interval '90 days';
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    deleted_count := _deleted;
  END IF;
  IF _candidate > 0 THEN
    RETURN NEXT;
  END IF;

  -- 6) Archived pg-boss jobs > 30 days
  -- pg-boss 10 schema: pgboss.archive, column: archivedon (timestamptz)
  IF EXISTS (
    SELECT 1 FROM information_schema.tables AS catalog_table
     WHERE catalog_table.table_schema = 'pgboss'
       AND catalog_table.table_name = 'archive'
  ) THEN
    SELECT count(*) INTO _candidate
      FROM pgboss.archive
     WHERE archivedon < now() - interval '30 days';

    table_name := 'pgboss.archive';
    candidate_count := _candidate;
    deleted_count := 0;

    IF NOT dry_run AND _candidate > 0 THEN
      DELETE FROM pgboss.archive
       WHERE archivedon < now() - interval '30 days';
      GET DIAGNOSTICS _deleted = ROW_COUNT;
      deleted_count := _deleted;
    END IF;
    IF _candidate > 0 THEN
      RETURN NEXT;
    END IF;
  END IF;

END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Security: REVOKE from PUBLIC, grant only to worker
-- ----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION prune_non_audit_data(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_non_audit_data(boolean) TO leadops_worker;
GRANT EXECUTE ON FUNCTION prune_non_audit_data(boolean) TO leadops_worker_test;
