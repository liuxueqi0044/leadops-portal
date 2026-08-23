# Forward-Fix Migration

**Purpose:** Fix a broken database migration by writing and applying a **new forward migration** rather than attempting to reverse a migration that has already been applied in production.

**Expected duration:** 30-60 minutes (write, test, deploy, apply).

---

## Preconditions

- `DATABASE_OWNER_URL` is configured for the target environment.
- You have a local or staging copy of the production schema at the same migration level.
- You have access to the `packages/db/migrations/` directory.
- The migration runner (`packages/db/src/migrate/runner.ts`) is in place.

---

## Stop / Abort Conditions

- **Never** delete or edit an already-applied migration file. The `schema_migrations` table tracks applied migrations by filename, and modifications will break idempotency.
- If the broken migration was **not yet applied** anywhere, you may safely edit the migration file and re-run. This runbook assumes it **has** been applied.

---

## Step-by-Step Procedure

### 1. Confirm which migrations are applied

```powershell
$env:DATABASE_OWNER_URL = "postgresql://leadops:leadops_dev@localhost:5432/leadops"
$env:PGPASSWORD = "leadops_dev"
psql -h localhost -U leadops -d leadops -c "SELECT name, applied_at FROM schema_migrations ORDER BY name;"
```

Expected output: list of applied migration filenames with timestamps.

### 2. Identify the problem

```powershell
# Inspect the relevant migration SQL file:
Get-Content packages/db/migrations/00XX_problematic_migration.sql

# Check for errors in the database that it left behind:
psql -h localhost -U leadops -d leadops -c "\dt"
psql -h localhost -U leadops -d leadops -c "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname;"
```

### 3. Write a new forward migration

Create a new file in `packages/db/migrations/` with the next sequence number:

```powershell
# Determine next migration number:
Get-ChildItem packages/db/migrations/*.sql | ForEach-Object { $_.Name } | Sort-Object | Select-Object -Last 1
# Example: if last is 0012_phase6c_retention.sql, create 0013_fix_<description>.sql
```

Write the migration SQL. Examples of common fix patterns:

**Add a missing index:**
```sql
-- 0013_add_missing_lead_email_index.sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_email_idx ON leads (email);
```

**Fix a constraint:**
```sql
-- 0013_relax_workflow_name_constraint.sql
ALTER TABLE workflows ALTER COLUMN name TYPE varchar(500);
```

**Add a missing column:**
```sql
-- 0013_add_metadata_to_clients.sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
```

**Grant permissions to runtime role:**
```sql
-- 0013_grant_leads_to_runtime.sql
GRANT SELECT, INSERT, UPDATE ON leads TO leadops_runtime;
```

### 4. Test the migration on a local copy

```powershell
# Start local Postgres if not running:
docker compose up -d postgres

# Apply all pending migrations including the new one:
$env:DATABASE_OWNER_URL = "postgresql://leadops:leadops_dev@localhost:5432/leadops"
pnpm db:migrate
```

Expected output:
```
migrations applied: 1, skipped: 12
  applied: 0013_fix_<description>.sql
  ...
```

### 5. Verify the fix

```powershell
# Run application tests against the migrated database:
pnpm test:db

# Run integration tests:
pnpm test:integration
```

### 6. Deploy and apply in the target environment

```powershell
# 1. Deploy the new code (which includes the migration file):
git push  # or CI/CD pipeline deploys

# 2. Apply the migration on the production database:
$env:DATABASE_OWNER_URL = "<production-owner-url>"
pnpm db:migrate
```

### 7. Mark the incident resolved

Once the migration is applied and verified, update any open incidents:

```powershell
# Via the API:
$headers = @{ "Content-Type" = "application/json" }
$body = '{"resolution":"Migration 0013 applied to fix <issue>"}' | ConvertFrom-Json
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/incidents/<incident-id>/resolve" -Method Post -Headers $headers -Body ($body | ConvertTo-Json)
```

---

## Verification

1. `schema_migrations` table contains the new migration entry.
2. Application health checks pass (`/api/health/ready`).
3. The original error condition no longer reproduces.
4. `pnpm test:db` passes with the new migration applied.
5. Worker starts successfully with `pg-boss started with job registry`.

---

## Rollback Path (undo the fix migration)

If the fix migration itself causes problems, write another forward migration:

```sql
-- 0014_revert_fix_<description>.sql
-- Reverse the change from 0013 (e.g., DROP INDEX, ALTER TABLE back, etc.)
```

**Never** attempt to delete the row from `schema_migrations` — the migration runner is idempotent only in the forward direction.
