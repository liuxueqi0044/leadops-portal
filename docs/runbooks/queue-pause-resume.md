# Queue Pause / Resume

**Purpose:** Gracefully pause pg-boss job processing and the outbox dispatcher to perform maintenance, investigate issues, or stop a storm of failing jobs — then resume processing cleanly.

**Expected duration:** 2-5 minutes to pause; resume is instant on restart.

---

## Architecture Overview

The worker (`apps/worker/src/index.ts`) manages these queue subsystems:

| Subsystem | Mechanism | Tables |
|---|---|---|
| pg-boss jobs | `PgBoss.work()` / `boss.stop()` | `pgboss.job`, `pgboss.archive` |
| Outbox dispatcher | `createOutboxDispatcher()` poll loop | `outbox` |
| Schedulers (4) | `setInterval` poll loops | Domain tables via SQL functions |
| Heartbeat | `setInterval` with `SELECT 1` | None |

The pg-boss schema name is `pgboss` (production) or `pgboss_test` (test), controlled by `PG_BOSS_SCHEMA` env var.

---

## Preconditions

- `WORKER_DATABASE_URL` is accessible (read/write).
- `DATABASE_OWNER_URL` is accessible if you need to manipulate pg-boss tables directly.
- You know the name of the pg-boss schema: `$env:PG_BOSS_SCHEMA` (defaults to `pgboss`).

---

## Stop / Abort Conditions

- Do **not** kill the worker with `SIGKILL` — pg-boss jobs mid-flight will be left in `active` state and must be manually cleaned up.
- If the worker cannot be reached (hung process), use `pg_terminate_backend` on its database connections as a last resort.
- Long-running jobs (e.g., `retention.prune-non-audit-data` with 300s timeout) will run to completion even after `SIGTERM` unless their timeout fires.

---

## A. Graceful Pause (Stop the Worker)

### A1. Send SIGTERM to the worker

```powershell
# If running via docker compose:
docker compose stop worker

# If running via process manager, find the PID and signal:
Get-Process -Name "node" | Where-Object { $_.CommandLine -like "*worker*" }
# Then: Stop-Process -Id <PID>   (sends SIGTERM on Windows via Ctrl+C equivalent)
```

The worker handles `SIGTERM` via the shutdown handler in `apps/worker/src/index.ts:314`. The shutdown sequence is:

1. Stop schedulers (4 poll loops)
2. Stop outbox dispatcher
3. `boss.stop({ timeout: 10_000 })` — waits up to 10s for in-flight jobs
4. `runtime.shutdown(signal)` — closes database connection pool

### A2. Confirm the worker has stopped

```powershell
# Check docker:
docker compose ps worker
# Status should be "exited"

# Check logs for clean shutdown:
docker compose logs worker --tail=30 | Select-String "shutdown|closed"
```

Expected log lines:
```
worker.shutdown  Shutting down
worker.closed    Worker closed cleanly
```

### A3. Verify no active pg-boss jobs remain

```powershell
$env:DATABASE_OWNER_URL = "postgresql://leadops:leadops_dev@localhost:5432/leadops"
$env:PGPASSWORD = "leadops_dev"

# Check for active (in-flight) jobs in the pgboss schema:
psql -h localhost -U leadops -d leadops -c "SELECT name, state, count(*) FROM pgboss.job GROUP BY name, state ORDER BY state, name;"

# Check for pending jobs:
psql -h localhost -U leadops -d leadops -c "SELECT name, count(*) FROM pgboss.job WHERE state = 'created' OR state = 'retry' GROUP BY name ORDER BY name;"

# Check outbox pending items:
psql -h localhost -U leadops -d leadops -c "SELECT status, count(*) FROM outbox GROUP BY status;"
```

### A4. (Optional) Manually clear stuck jobs in `active` state

If a job was left in `active` state (e.g., due to kill -9), move it back to `created`:

```sql
-- Move active jobs back to created so they retry on worker restart:
UPDATE pgboss.job
SET state = 'created', startedon = NULL
WHERE state = 'active'
  AND startedon < now() - interval '5 minutes';

-- Cancel specific jobs by name:
DELETE FROM pgboss.job WHERE name = 'events.project' AND state = 'created';
```

### A.5 (Optional) Pause submission without stopping the worker

To prevent **new** jobs from being created while the worker continues processing existing ones:

```sql
-- Prevent outbox dispatcher from claiming new items:
-- (Set lockedBy on all pending items to a dummy worker)
UPDATE outbox
SET lockedBy = 'maintenance-pause',
    lockedAt = now(),
    nextAttemptAt = now() + interval '30 minutes'
WHERE status = 'pending'
  AND lockedBy IS NULL;
```

---

## B. Resume (Start the Worker)

### B1. Start the worker

```powershell
docker compose up -d worker
```

### B2. Verify the worker starts cleanly

```powershell
# Watch startup logs:
docker compose logs worker -f

# Wait for the startup message:
docker compose logs worker | Select-String "pg-boss started with job registry"
```

Expected log:
```
pgboss.started  pg-boss started with job registry
worker.startup  Worker starting
worker.heartbeat  Worker heartbeat
outbox.start   Outbox dispatcher started
```

### B3. Verify queues are processing

```powershell
# Check pg-boss job counts after 1 minute:
psql -h localhost -U leadops -d leadops -c "SELECT name, state, count(*) FROM pgboss.job GROUP BY name, state ORDER BY state, name;"

# Check outbox is draining:
psql -h localhost -U leadops -d leadops -c "SELECT status, count(*) FROM outbox GROUP BY status;"

# Check worker logs for job processing:
docker compose logs worker --tail=50 | Select-String "completed|enqueued|claimed"
```

### B4. Confirm schedulers are running

```powershell
docker compose logs worker --tail=50 | Select-String "Scheduled|Enqueued"
```

Expected periodic log lines:
- `Scheduled approval expiration for N tenants`
- `Enqueued N approval deliveries`
- `Enqueued N email deliveries`
- `Scheduled weekly reports for N clients`

---

## C. Emergency: Clear a Backlog

If a large number of jobs have accumulated during the pause:

### C1. Assess the backlog

```powershell
psql -h localhost -U leadops -d leadops -c "SELECT name, state, count(*) FROM pgboss.job WHERE state IN ('created', 'retry') GROUP BY name, state ORDER BY count(*) DESC;"
```

### C2. Increase outbox concurrency temporarily

Set a higher `OUTBOX_CONCURRENCY` (default 4) and restart:

```powershell
$env:OUTBOX_CONCURRENCY = "16"
$env:OUTBOX_BATCH_SIZE = "50"
docker compose up -d worker
```

### C3. Purge poison jobs

If specific jobs are failing in a loop:

```sql
-- Cancel all failing instances of a specific job:
DELETE FROM pgboss.job
WHERE name = '<job-name>'
  AND state IN ('created', 'retry')
  AND retrylimit >= retrycount;
```

---

## Verification

1. `docker compose ps worker` shows `Up` (running).
2. Worker logs show `pg-boss started with job registry`.
3. `pgboss.job` has no unexpected `active` rows older than 5 minutes.
4. `outbox` `pending` count is decreasing (or stable at 0).
5. Health check: `Invoke-RestMethod http://localhost:3000/api/health/ready` returns 200.
6. Scheduler log lines appear within 2 poll cycles (10-600 seconds depending on config).

---

## Notes

- `PG_BOSS_SCHEMA` defaults to `pgboss_test` when the connection username is `leadops_worker_test`, otherwise `pgboss`. Verify with `echo $env:PG_BOSS_SCHEMA` before querying.
- `boss.stop()` timeout is 10 seconds. Jobs that exceed their per-handler timeout will be abandoned and retried on next worker start.
- The `archiveCompletedAfterSeconds: 172_800` (48h) setting means completed jobs remain in `pgboss.archive` for 2 days before pg-boss cleans them up.
