# Application Rollback

**Purpose:** Roll back the web application and/or worker to a previous known-good deployment when a bad deploy causes regressions, errors, or downtime.

**Expected duration:** 5-15 minutes (deployment platform dependent).

---

## Preconditions

- The previous deployment artifact (Docker image tag, commit SHA, or build) is still available.
- You have deploy access to the target environment (staging or production).
- Database migrations have **not** been run forward since the last known-good deploy — or you have a migration revert plan.
- Monitoring dashboards are accessible to observe recovery.

---

## Stop / Abort Conditions

- **Do not rollback** if forward-only database migrations have already been applied and would break the old application code. Prefer a forward-fix deploy in that case (see `forward-fix-migration.md`).
- Abort if the deployment artifact for the previous version is missing or corrupted.

---

## Step-by-Step Procedure

### 1. Identify the last known-good deployment

```powershell
# If using git tags:
git tag --sort=-creatordate | Select-Object -First 10

# If using container registry, list recent image tags:
# Adjust to your registry (e.g. ghcr.io, docker hub)
docker image ls leadops-web --format "{{.Tag}}" | Select-Object -First 10
```

Record the target tag/commit: `________________`

### 2. (If migrations were run) Verify migration compatibility

```powershell
# Check which migrations are applied in the target database:
$env:DATABASE_OWNER_URL = "postgresql://leadops:leadops_dev@localhost:5432/leadops"
pnpm tsx packages/db/scripts/list-applied.ts
```

If migrations were applied **after** the target rollback version, assess whether the old application code can tolerate the new schema. If not, you need a forward-fix instead.

### 3. Stop the current web and worker processes

```powershell
# If running via docker compose:
docker compose stop web worker

# If running via systemd / process manager, signal the process:
# SIGTERM first, then SIGKILL after WORKER_SHUTDOWN_TIMEOUT_MS (default 10s)
```

### 4. Deploy the previous version

```powershell
# Docker Compose example:
$env.WEB_IMAGE_TAG = "<previous-tag>"
$env.WORKER_IMAGE_TAG = "<previous-tag>"
docker compose up -d web worker

# Or if using direct process management:
git checkout <previous-commit-or-tag>
pnpm install --frozen-lockfile
pnpm build
# Restart worker and web processes
```

### 5. Verify the services are healthy

```powershell
# Check web health endpoints:
Invoke-RestMethod -Uri "http://localhost:3000/api/health/live" | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3000/api/health/ready" | ConvertTo-Json

# Check worker logs for successful startup:
docker compose logs worker --tail=20
```

Expected output: `{"status":"ok"}` from health endpoints. Worker logs should show `pg-boss started with job registry`.

### 6. Monitor for recovery

```powershell
# Watch logs for errors:
docker compose logs -f web worker

# Check database connectivity from worker heartbeat:
docker compose logs worker | Select-String "Worker heartbeat"
```

---

## Verification

1. `/api/health/live` returns `200 OK`.
2. `/api/health/ready` returns `200 OK` (database reachable).
3. Worker logs show `pg-boss started with job registry` with expected enabled jobs.
4. No spike in error rates after 2 minutes.
5. Key user flows (login, lead list, approval decision) return expected responses.

---

## Rollback Path (undo the rollback)

Re-deploy the newer version once the root cause is fixed:

```powershell
git checkout <original-branch>
pnpm install --frozen-lockfile
pnpm build
docker compose up -d web worker
```

---

## Notes

- Rollback only the component that broke (web or worker), not both unnecessarily.
- The database is **not** rolled back by this procedure. If schema changes are the problem, see `forward-fix-migration.md`.
- Session tokens signed with `BETTER_AUTH_SECRET` remain valid across deploys as long as the secret does not change.
