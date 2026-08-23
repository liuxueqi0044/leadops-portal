# Staging Deployment

## Architecture Overview

LeadOps Portal is deployed as three independently deployable units from a single pnpm monorepo:

| Unit | Package | Runtime | Role |
|------|---------|---------|------|
| **Web** | `apps/web` | Next.js 15 (Node.js) | HTTP API, SSR pages, authentication |
| **Worker** | `apps/worker` | Node.js + pg-boss | Background jobs: AI qualification, approval delivery, email, scheduling |
| **Migration** | `packages/db` | tsx one-shot | Drizzle ORM schema migrations (serial, blocking) |

Web and Worker are independently scalable. Migration runs once per deployment as a serial gate — it must succeed before either app process starts the new version.

```
                     ┌──────────────┐
    HTTPS ──────────►│   Web (xN)   │──┐
                     └──────┬───────┘  │
                            │          │
                     ┌──────▼───────┐  │
                     │  PostgreSQL  │◄─┤
                     │    16        │  │
                     └──────▲───────┘  │
                            │          │
   n8n webhooks ───────────┤          │
                            │          │
                     ┌──────┴───────┐  │
                     │ Worker (xN)  │◄─┘
                     └──────────────┘
```

## Prerequisites

| Requirement | Version / Notes |
|-------------|-----------------|
| Node.js | >= 22 |
| pnpm | >= 9 (lockfile pinned to 11.18.0) |
| PostgreSQL | 16 |
| Docker | For local dev (docker-compose.yml) |

Verify:

```bash
node --version   # >= v22
pnpm --version   # >= 9
psql --version   # >= 16
```

## Environment Variables

All variables listed in `.env.example`. Required for staging:

```bash
# --- Database (three separate roles) ---
DATABASE_OWNER_URL=postgresql://leadops:<owner-password>@<staging-host>:5432/leadops_staging
DATABASE_URL=postgresql://leadops_runtime:<runtime-password>@<staging-host>:5432/leadops_staging
WORKER_DATABASE_URL=postgresql://leadops_worker:<worker-password>@<staging-host>:5432/leadops_staging
PG_BOSS_SCHEMA=pgboss

# --- Encryption ---
LEADOPS_ENCRYPTION_KEY=<64-hex-characters>

# --- Logging ---
LOG_LEVEL=info

# --- Web ---
PORT=3000
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://staging.example.com
CORS_ORIGIN=https://staging.example.com

# --- Worker ---
WORKER_HEARTBEAT_MS=30000
WORKER_SHUTDOWN_TIMEOUT_MS=10000
OUTBOX_POLL_MS=5000
OUTBOX_BATCH_SIZE=20
OUTBOX_CONCURRENCY=4

# --- AI (staging and production require a real provider) ---
AI_PROVIDER=openai
AI_MODEL=<staging-model>
AI_API_KEY=<staging-provider-key>
AI_BASE_URL=
AI_INPUT_USD_PER_MILLION_TOKENS=<model-input-price>
AI_OUTPUT_USD_PER_MILLION_TOKENS=<model-output-price>
AI_MAX_OUTPUT_TOKENS=500
AI_MAX_INPUT_LENGTH=10000
AI_MAX_COST_CENTS=1000
AI_TIMEOUT_MS=30000

# --- Email and alerting ---
EMAIL_PROVIDER=resend
RESEND_API_KEY=<staging-resend-key>
RESEND_FROM=<verified-staging-sender>
ALERT_WEBHOOK_URL=https://alerts-staging.example.com/leadops

# --- OpenTelemetry ---
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-staging.example.com:4318
```

Generate `LEADOPS_ENCRYPTION_KEY`:

```bash
openssl rand -hex 32
```

Generate `BETTER_AUTH_SECRET`:

```bash
openssl rand -base64 32
```

## Build

```bash
# Install dependencies (CI uses --frozen-lockfile)
pnpm install --frozen-lockfile

# Type-check all packages and apps
pnpm typecheck

# Run unit tests
pnpm test

# Build everything (packages first, then apps)
pnpm build
```

Build outputs:
- `apps/web/.next/` — Next.js standalone output
- `apps/worker/dist/` — compiled TypeScript (entry: `dist/index.js`)
- `packages/*/dist/` — compiled library packages

## Database Migration Procedure

Migrations are serial and must block rollout. Never run migrations concurrently with a running app.

### Step 1: Stop Web and Worker

```bash
# Signal both processes to stop. Grace period: WORKER_SHUTDOWN_TIMEOUT_MS (default 10s).
# If using a process manager (pm2, systemd, Kubernetes):
systemctl stop leadops-web leadops-worker
# or: kubectl scale deployment leadops-web leadops-worker --replicas=0
```

Verify both are fully stopped:

```bash
# Check no process is listening on PORT
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/v1/health || echo "stopped"
```

### Step 2: Run Migrations

```bash
pnpm db:migrate
```

This executes `packages/db/scripts/migrate.ts` which:
1. Reads `DATABASE_OWNER_URL` (must be set — the script exits if missing)
2. Calls `applyMigrations(ownerUrl)` to run pending Drizzle migrations
3. Prints each applied and skipped migration name

Expected output:

```
migrations applied: 3, skipped: 0
  applied: 0000_initial
  applied: 0001_rls_policies
  applied: 0002_outbox
```

### Step 3: Verify Migration Success

```bash
# Check exit code. Failure is non-zero.
pnpm db:migrate
# Exit code 0              = success (no pending or already up-to-date)
# Exit code non-zero       = BLOCK ROLLOUT — do not start apps
```

If migration fails:
- **Do not** start the new Web or Worker version.
- Roll back to the previous app version (which matches the existing schema).
- Investigate and fix the migration script before retrying.

### Step 4: Start Web and Worker (new version)

Only proceed after Step 3 passes with exit code 0.

## Web Deployment

### Using Node directly

```bash
cd apps/web
NODE_ENV=production node node_modules/.bin/next start --port 3000
```

### Using a process manager (pm2)

```bash
pm2 start apps/web/node_modules/.bin/next --name leadops-web -- start --port 3000
```

### Using Docker (see Dockerfile reference section in production.md)

```bash
docker run -d --name leadops-web \
  -p 3000:3000 \
  --env-file .env \
  leadops-portal:staging web
```

### Health check

```bash
# Liveness — process is alive
curl -f http://localhost:3000/api/v1/health/live

# Readiness — database is reachable
curl -f http://localhost:3000/api/v1/health/ready
```

Expected responses:

```
GET /api/v1/health/live  → 200 {"status":"ok","timestamp":"..."}
GET /api/v1/health/ready → 200 {"status":"ok","timestamp":"..."}
                         → 503 {"status":"error","timestamp":"..."}
```

## Worker Deployment

### Using Node directly

```bash
cd apps/worker
node dist/index.js
```

### Using pm2

```bash
pm2 start apps/worker/dist/index.js --name leadops-worker
```

### Using Docker

```bash
docker run -d --name leadops-worker \
  --env-file .env \
  leadops-portal:staging worker
```

### Worker health verification

The worker emits heartbeats at `WORKER_HEARTBEAT_MS` intervals. Verify it has registered with pg-boss:

```sql
SELECT name, count(*) FROM pgboss.job GROUP BY name;
```

Check the worker logs for:

```
{"level":"info","msg":"worker started","workerId":"..."}
{"level":"info","msg":"pg-boss started"}
```

## Health Check Verification

Run this checklist after deploying both units:

1. **Web /live**: `curl -f http://localhost:3000/api/v1/health/live`
2. **Web /ready**: `curl -f http://localhost:3000/api/v1/health/ready`
3. **Worker heartbeat**: Check logs for periodic heartbeat entries
4. **API health**: `curl -f http://localhost:3000/api/v1/health`
5. **pg-boss queues**: Query `pgboss.job` for registered queue names
6. **Authentication**: Attempt login flow with a staging user

```bash
# Combined smoke test
curl -f http://localhost:3000/api/v1/health/live && echo "Web live: OK"
curl -f http://localhost:3000/api/v1/health/ready && echo "Web ready: OK"
curl -f http://localhost:3000/api/v1/health && echo "API health: OK"
```

## Rollback Procedure

### Application rollback

1. Stop Web and Worker (in that order):

```bash
systemctl stop leadops-web leadops-worker
```

2. Deploy the previous application version (previous Docker image tag or git commit):

```bash
git checkout <previous-release-tag>
pnpm install --frozen-lockfile
pnpm build
```

3. Start Web and Worker:

```bash
systemctl start leadops-web leadops-worker
```

4. Verify health checks pass.

### Database rollback (forward-fix preferred)

Drizzle migrations are forward-only by default. If a migration introduced a bug:

1. **Preferred**: Write a new forward migration that fixes the issue.
2. **Last resort**: Restore from backup (see backup procedure in production.md).

**Do not** manually edit the production schema outside of migrations.

## Expected Timeline

| Step | Duration |
|------|----------|
| `pnpm install --frozen-lockfile` | ~2 min |
| `pnpm typecheck` + `pnpm test` | ~3 min |
| `pnpm build` | ~3 min |
| Stop Web + Worker | ~15 sec |
| `pnpm db:migrate` | ~10 sec |
| Start Web | ~5 sec |
| Start Worker | ~5 sec |
| Health check verification | ~30 sec |
| **Total (automated)** | **~10 min** |
| **Total (manual)** | **~15 min** |

## Notes

- Staging and production both fail closed when an AI or email provider is fake.
- Staging should use an isolated database — never share the production database.
- Staging n8n instances should use test accounts, not production third-party credentials.
- Always run `pnpm test:db` with a test database before promoting to staging.
