# Database Restore

**Purpose:** Restore a PostgreSQL database from a `pg_dump` custom-format backup into an isolated database, validate integrity, and optionally promote it as the new primary.

**Expected duration:** 10-60 minutes depending on database size.

---

## Background

- **DATABASE_OWNER_URL**: used for migrations, schema changes, and restore operations. Uses the `leadops` superuser (development) or equivalent owner role.
- **DATABASE_URL**: used by the web app at runtime. Uses `leadops_runtime` (least-privilege RLS-enforced role).
- **WORKER_DATABASE_URL**: used by the worker. Uses `leadops_worker` (dedicated worker role).
- Migrations are tracked in `schema_migrations` table.
- pg-boss uses a dedicated schema: `pgboss` (prod) or `pgboss_test` (test).
- Database roles: `leadops` (owner), `leadops_runtime` (app), `leadops_worker` (worker).

---

## Preconditions

- Docker Compose with postgres:16-alpine is available locally.
- A valid `pg_dump` custom-format backup file exists (`.dump` or `.pgdmp`).
- `DATABASE_OWNER_URL` is configured with a role that can create databases and roles.
- Enough disk space for the restored database (at least 2x the backup size).
- The target environment's `DATABASE_URL` and `WORKER_DATABASE_URL` can be updated.

---

## Stop / Abort Conditions

- If the backup file is corrupt: `pg_restore -l backup.dump` will fail. Do not proceed.
- If the target database name already exists and contains production data: use a different restore database name to avoid overwriting live data.
- If disk space is critically low (< 20% free on the Postgres data volume), abort and free space first.

---

## Step-by-Step Procedure

### 1. Validate the backup file

```powershell
# List contents of the backup (custom format):
$env:PGPASSWORD = "leadops_dev"
pg_restore -h localhost -U leadops -d leadops --list backup.dump

# Check the backup file size and integrity:
Get-Item backup.dump | Select-Object Name, Length
```

If `pg_restore --list` fails, the backup is corrupt. Do not proceed.

### 2. Create an isolated restore database

```powershell
# Connect as owner and create a new database:
$env:PGPASSWORD = "leadops_dev"

psql -h localhost -U leadops -d postgres -c "CREATE DATABASE leadops_restore OWNER leadops;"
Write-Host "Created isolated restore database: leadops_restore"
```

### 3. Restore the backup into the isolated database

```powershell
# Restore with custom format, verbose output:
$env:PGPASSWORD = "leadops_dev"
pg_restore -h localhost -U leadops -d leadops_restore --no-owner --no-privileges --verbose --clean --if-exists backup.dump
```

Explanation of flags:
- `--no-owner`: Don't set object ownership (avoids role mismatch errors).
- `--no-privileges`: Don't restore GRANT/REVOKE statements.
- `--clean --if-exists`: Drop existing objects before creating (safe on an empty database).
- `--verbose`: Show progress for large databases.

### 4. Apply any pending migrations

The restored database may be at an older migration level than the current application code:

```powershell
$env:DATABASE_OWNER_URL = "postgresql://leadops:leadops_dev@localhost:5432/leadops_restore"
pnpm db:migrate
```

Expected output:
```
migrations applied: N, skipped: M
  applied: 0013_fix_...
```

### 5. Recreate runtime roles and permissions

The restored database may be missing the runtime roles or have incorrect grants:

```powershell
$env:PGPASSWORD = "leadops_dev"

psql -h localhost -U leadops -d leadops_restore -c @"
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadops_runtime') THEN
    CREATE ROLE leadops_runtime WITH LOGIN PASSWORD 'leadops_runtime_dev' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadops_worker') THEN
    CREATE ROLE leadops_worker WITH LOGIN PASSWORD 'leadops_worker_dev' NOBYPASSRLS;
  END IF;
END
\$\$;
"@

# Re-apply grants from the latest migration that creates roles/grants.
# The most reliable way is to re-run the migration that sets up roles:
psql -h localhost -U leadops -d leadops_restore -f packages/db/migrations/0002_harden_platform_rls.sql
```

Or, apply grants manually based on the schema:

```sql
GRANT USAGE ON SCHEMA public TO leadops_runtime;
GRANT USAGE ON SCHEMA public TO leadops_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO leadops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO leadops_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO leadops_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO leadops_worker;
```

### 6. Reset pg-boss state

The restored pg-boss schema may contain stale job states. Reset them:

```powershell
# Determine the pg-boss schema name:
$pgBossSchema = if ($env:PG_BOSS_SCHEMA) { $env:PG_BOSS_SCHEMA } else { "pgboss" }

# Cancel all active/created jobs from the backup (they are stale):
psql -h localhost -U leadops -d leadops_restore -c @"
UPDATE $pgBossSchema.job SET state = 'cancelled' WHERE state IN ('active', 'created', 'retry');
"@
```

### 7. Validate the restored database

```powershell
# Verify row counts on key tables:
$env:PGPASSWORD = "leadops_dev"
$env:DATABASE_URL = "postgresql://leadops_runtime:leadops_runtime_dev@localhost:5432/leadops_restore"

psql -h localhost -U leadops -d leadops_restore -c @"
SELECT 'organizations' AS tbl, count(*) FROM organizations
UNION ALL SELECT 'users', count(*) FROM users
UNION ALL SELECT 'clients', count(*) FROM clients
UNION ALL SELECT 'leads', count(*) FROM leads
UNION ALL SELECT 'business_events', count(*) FROM business_events
UNION ALL SELECT 'outbox', count(*) FROM outbox
UNION ALL SELECT 'integrations', count(*) FROM integrations
UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations;
"@

# Check for RLS policies:
psql -h localhost -U leadops -d leadops_restore -c @"
SELECT schemaname, tablename, policyname, permissive, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
"@

# Verify the runtime role can access data:
psql -h localhost -U leadops_runtime -d leadops_restore -c "SELECT count(*) FROM organizations;"

# Verify the worker role can access data:
psql -h localhost -U leadops_worker -d leadops_restore -c "SELECT count(*) FROM outbox;"
```

### 8. Test the application against the restored database

```powershell
# Point DATABASE_URL and WORKER_DATABASE_URL to the restored database:
$env:DATABASE_URL = "postgresql://leadops_runtime:leadops_runtime_dev@localhost:5432/leadops_restore"
$env:WORKER_DATABASE_URL = "postgresql://leadops_worker:leadops_worker_dev@localhost:5432/leadops_restore"

# Start web and worker against restored DB:
docker compose up -d

# Run smoke tests:
Invoke-RestMethod -Uri "http://localhost:3000/api/health/live"
Invoke-RestMethod -Uri "http://localhost:3000/api/health/ready"
Invoke-RestMethod -Uri "http://localhost:3000/api/health/startup"

# Run database tests against restored DB:
$env:DATABASE_URL = "postgresql://leadops_runtime:leadops_runtime_dev@localhost:5432/leadops_restore"
pnpm test:db
```

### 9. Promote to production (if validated)

```powershell
# Option A: Rename databases (requires no active connections):
psql -h localhost -U leadops -d postgres -c @"
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN ('leadops', 'leadops_restore')
  AND pid <> pg_backend_pid();
"@

psql -h localhost -U leadops -d postgres -c "ALTER DATABASE leadops RENAME TO leadops_old;"
psql -h localhost -U leadops -d postgres -c "ALTER DATABASE leadops_restore RENAME TO leadops;"

# Option B: Update environment variables to point to the restored DB permanently:
$env:DATABASE_URL = "postgresql://leadops_runtime:leadops_runtime_dev@localhost:5432/leadops_restore"
docker compose up -d web worker
```

---

## Verification Checklist

| Check | Command | Expected |
|---|---|---|
| Backup is valid | `pg_restore --list backup.dump` | Lists all objects without error |
| Row counts match | `SELECT count(*) FROM ...` | Matches expected counts |
| Migrations applied | `SELECT count(*) FROM schema_migrations` | Matches current migration count |
| RLS policies exist | `SELECT * FROM pg_policies WHERE schemaname='public'` | Policies listed for all tenant tables |
| Runtime role can read | `psql -U leadops_runtime -c "SELECT..."` | Returns data |
| Worker role can read | `psql -U leadops_worker -c "SELECT..."` | Returns data |
| Web health check | `GET /api/health/ready` | 200 OK |
| Worker starts | `docker compose logs worker` | "pg-boss started with job registry" |

---

## Rollback Path

If the restored database is problematic:

```powershell
# If you renamed the original database:
psql -h localhost -U leadops -d postgres -c @"
ALTER DATABASE leadops RENAME TO leadops_bad_restore;
ALTER DATABASE leadops_old RENAME TO leadops;
"@
docker compose up -d web worker

# If you used a separate database name, just point back:
$env:DATABASE_URL = "<original-url>"
$env:WORKER_DATABASE_URL = "<original-worker-url>"
docker compose up -d web worker
```

### Cleanup

```powershell
# Remove the old database once the restore is confirmed stable:
psql -h localhost -U leadops -d postgres -c "DROP DATABASE IF EXISTS leadops_old;"

# Remove the restore database if it was a temporary test:
psql -h localhost -U leadops -d postgres -c "DROP DATABASE IF EXISTS leadops_restore;"
```

---

## Notes

- `pg_dump` custom format (`-Fc`) is preferred because it supports parallel restore (`-j N`), selective restore (`--table`, `--schema`), and compression.
- To create a backup: `pg_dump -h localhost -U leadops -d leadops -Fc --no-owner --no-privileges -f backup_$(Get-Date -Format 'yyyyMMdd-HHmmss').dump`
- For large databases, use parallel restore: `pg_restore -j 4 -d leadops_restore backup.dump`
