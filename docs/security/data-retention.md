# Data Retention Policies

## Overview

Data retention is implemented as a PostgreSQL `SECURITY DEFINER` function `prune_non_audit_data(boolean, integer)` defined in migration `0012_phase6c_retention.sql`. The function operates on a fixed whitelist of tables — the caller cannot pass arbitrary table names or SQL. Execution is restricted to `leadops_worker` and `leadops_worker_test` roles.

A scheduled pg-boss job `retention.prune-non-audit-data` invokes this function. It runs with `system` scope (no tenant context required).

## Retention Schedule

### Prunable Tables

| Table                | Condition                                         | Retention Period       |
| -------------------- | ------------------------------------------------- | ---------------------- |
| `sessions`           | `expiresAt < now() - interval '90 days'`          | Expired > 90 days      |
| `verifications`      | `expiresAt < now() - interval '90 days'`          | Expired > 90 days      |
| `outbox`             | `status IN ('delivered', 'failed')` AND `updatedAt < now() - interval '30 days'` | Terminal state > 30 days |
| `email_deliveries`   | `status IN ('sent', 'permanent_failure')` AND `createdAt < now() - interval '90 days'` | Terminal state > 90 days |
| `approval_deliveries` | `status IN ('delivered', 'dead_letter')` AND `createdAt < now() - interval '90 days'` | Terminal state > 90 days |
| `pgboss.archive`     | `archivedon < now() - interval '30 days'`         | Archived > 30 days     |

### Protected Tables — NEVER Pruned

These tables contain audit, operational, or regulatory-critical data that must be retained:

**Events & Audit:**
- `business_events` — Immutable source-of-truth for all inbound webhook events
- `audit_logs` — Platform-level audit trail
- `approval_history` — Immutable append-only log of all approval state transitions
- `approval_tokens` — Token hashes (one-time use tokens; consumed tokens are state-changed, not deleted)

**Incidents & Reports:**
- `incidents` — Operational incident records
- `incident_events` — Individual events within an incident
- `report_snapshots` — Weekly/monthly report data

**Lead Operations:**
- `leads` — Lead records
- `lead_status_history` — Status transition history
- `ai_runs` — AI qualification run records

**Identity & Auth (tenant identity/auth tables):**
- `users` — User identities
- `accounts` — OAuth/SSO provider accounts
- `organization_members` — Organization membership records
- `invitations` — Organization invitations
- `organizations` — Organization records
- `clients` — Client records
- `client_members` — Client membership records
- `client_assignments` — Integration-to-client bindings

**Integrations & Workflows:**
- `integrations` — Integration definitions
- `integration_secrets` — Encrypted secrets (versioned)
- `workflows` — Workflow definitions
- `workflow_runs` — Workflow execution history

**Approvals:**
- `approvals` — Approval records (state-changed, not deleted)

**System:**
- `pgboss.job`, `pgboss.schedule`, `pgboss.subscription` — Managed by pg-boss internally
- `schema_migrations` — Migration history
- `retention_policies` — The retention configuration table itself

## How to Run Retention

### Via the pg-boss Worker (Recommended)

The worker process (`apps/worker`) schedules `retention.prune-non-audit-data` as a pg-boss job. Configuration:

| Parameter          | Value                   |
| ------------------ | ----------------------- |
| Job name           | `retention.prune-non-audit-data` |
| Scope              | `system`                |
| Timeout            | 300,000 ms (5 minutes)  |
| Retry limit        | 2                       |
| Retry delay        | 10 seconds              |
| Idempotency        | Dry-run / whitelist     |

To schedule the job, insert a pg-boss job with payload:

```json
{
  "schemaVersion": 1,
  "dryRun": false
}
```

### Via SQL (Direct Execution)

Connect as a role with EXECUTE privilege on the function (`leadops_owner`):

```sql
-- Dry run: count candidates without deleting anything
SELECT * FROM prune_non_audit_data(dry_run => true);

-- Actual execution: count and delete
SELECT * FROM prune_non_audit_data(dry_run => false);

-- Override minimum retention with a custom floor (must be >= 7 days)
SELECT * FROM prune_non_audit_data(dry_run => false, min_retention_days => 14);
```

### API / Admin Dashboard

The retention job payload schema is defined in `apps/worker/src/jobs/registry.ts:84-86`:

```ts
const retentionPrunePayload = basePayload.extend({
  dryRun: z.boolean().optional(),
});
```

Any system with the ability to enqueue pg-boss jobs can trigger retention with `{ dryRun: true }` for a dry run or `{ dryRun: false }` for actual execution.

## Dry-Run vs Actual Execution

The `dry_run` parameter controls behavior:

| Parameter    | Dry Run (`true`)    | Actual (`false`)             |
| ------------ | ------------------- | ---------------------------- |
| Candidate count | Returned         | Returned                     |
| DELETE        | **Not executed**    | Executed with RETURNING clause |
| deleted_count | Always 0            | Actual rows deleted          |
| Logging       | `retention.table_result` with 0 deleted | `retention.table_result` with actual count |

The handler (`apps/worker/src/handlers/retention-prune.ts`) logs `retention.start`, per-table `retention.table_result`, and `retention.complete` events at `info` level.

**Recommendation**: Always run a dry run first and review the candidate counts before executing actual deletion. The function checks `min_retention_days >= 7` as a safety floor.

## Concurrent Execution Safety

- Row-level locking in DELETE ensures concurrent executions are safe
- The pg-boss job uses `idempotencyStrategy: "dry-run-whitelist"` to prevent duplicate scheduled runs
- The function is `STABLE` — it only reads from the target tables until the DELETE phase
- `pgboss.archive` pruning is conditional on the table's existence in the `pgboss` schema

## Retention Logging

The prune handler emits structured log events:

```json
{
  "event": "retention.start",
  "dryRun": true
}
{
  "event": "retention.table_result",
  "tableName": "sessions",
  "candidateCount": 150,
  "deletedCount": 0,
  "dryRun": true
}
{
  "event": "retention.complete",
  "dryRun": true,
  "tablesExamined": 3,
  "totalCandidates": 420,
  "totalDeleted": 0
}
```

## Retention Policy Configuration Table

The `retention_policies` table stores the canonical retention configuration:

| Column            | Type      | Description                                       |
| ----------------- | --------- | ------------------------------------------------- |
| `table_name`      | text PK   | Whitelisted table name                            |
| `retention_days`  | integer   | Minimum retention period (>= 7)                   |
| `status_column`   | text      | Column name for status                            |
| `terminal_statuses` | text[]  | Status values considered terminal                 |
| `date_column`     | text      | Column used for date comparison                   |
| `description`     | text      | Human-readable description                        |

This table is **not** user-modifiable at runtime. The function reads it for documentation purposes, but the actual prune logic is hardcoded (not dynamically driven by this table) to prevent accidental misconfiguration.
