# Production Deployment

## Architecture Overview

LeadOps Portal is deployed as three independently deployable units from a single pnpm monorepo:

| Unit | Package | Runtime | Role |
|------|---------|---------|------|
| **Web** | `apps/web` | Next.js 15 (Node.js) | HTTP API, SSR pages, authentication |
| **Worker** | `apps/worker` | Node.js + pg-boss | Background jobs: AI qualification, approval delivery, email, scheduling |
| **Migration** | `packages/db` | tsx one-shot | Drizzle ORM schema migrations (serial, blocking) |

Web and Worker are independently scalable behind a load balancer. Migration runs once per deployment as a serial gate — it **must** succeed before either app process starts the new version.

```
                         ┌──────────────────┐
   HTTPS ───────────────►│   CDN / WAF / LB │
                         └────────┬─────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
              ┌─────▼────┐ ┌─────▼────┐ ┌─────▼────┐
              │ Web (xN) │ │ Web (xN) │ │ Web (xN) │
              └─────┬────┘ └─────┬────┘ └─────┬────┘
                    │             │             │
                    └─────────────┼─────────────┘
                                  │
                         ┌────────▼────────┐
                         │  PostgreSQL 16   │
                         │  (Managed / HA)  │
                         └────────▲────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
              ┌─────┴────┐ ┌─────┴────┐ ┌─────┴────┐
              │Worker(xN)│ │Worker(xN)│ │Worker(xN)│
              └──────────┘ └──────────┘ └──────────┘
```

## Prerequisites

| Requirement | Version / Notes |
|-------------|-----------------|
| Node.js | >= 22 |
| pnpm | >= 9 (lockfile pinned to 11.18.0) |
| PostgreSQL | 16 (managed with automated backups) |
| Docker | For containerized deployment |
| OTLP collector | For traces and metrics |

Verify:

```bash
node --version   # >= v22
pnpm --version   # >= 9
psql --version   # >= 16
docker --version
```

## Production Requirements

### No fake providers, no default secrets

The worker's production startup **rejects** `AI_PROVIDER=fake`. Every environment variable must be set to production values.

| Variable | Requirement |
|----------|-------------|
| `AI_PROVIDER` | Must not be `fake`. Use `openai`, `anthropic`, or a compatible provider. |
| `AI_API_KEY` | Real API key. Must not be a placeholder. |
| `LEADOPS_ENCRYPTION_KEY` | 64 hex characters. Generate fresh per environment. Never reuse staging keys. |
| `BETTER_AUTH_SECRET` | Minimum 32 bytes of random data, base64-encoded. |
| `DATABASE_OWNER_URL` | Credentials with full DDL privileges. |
| `DATABASE_URL` | Least-privilege runtime role. Must not be superuser or own tables. |
| `WORKER_DATABASE_URL` | Dedicated worker role. Must not reuse `DATABASE_URL`. |
| `BETTER_AUTH_URL` | Public HTTPS base URL of the web app. |

**Checklist before first production deploy:**

- [ ] No `fake` value in any `AI_*` variable
- [ ] No hardcoded or default passwords in any `DATABASE_*` URL
- [ ] `LEADOPS_ENCRYPTION_KEY` is unique to production
- [ ] `BETTER_AUTH_SECRET` is unique to production
- [ ] Debug logging is off (`LOG_LEVEL=info` or `warn`)
- [ ] No test accounts or demo seed data in the production database

## Environment Variables

```bash
# --- Database (three separate roles — never share credentials) ---
DATABASE_OWNER_URL=postgresql://leadops_owner:<strong-password>@<prod-host>:5432/leadops
DATABASE_URL=postgresql://leadops_runtime:<strong-password>@<prod-host>:5432/leadops
WORKER_DATABASE_URL=postgresql://leadops_worker:<strong-password>@<prod-host>:5432/leadops
PG_BOSS_SCHEMA=pgboss

# --- Encryption ---
# Generate: openssl rand -hex 32
LEADOPS_ENCRYPTION_KEY=<64-hex-characters>

# --- Logging ---
LOG_LEVEL=info

# --- Web ---
PORT=3000

# --- Better Auth ---
# Generate: openssl rand -base64 32
BETTER_AUTH_SECRET=<random-base64>
BETTER_AUTH_URL=https://app.example.com
CORS_ORIGIN=https://app.example.com

# --- Worker ---
WORKER_HEARTBEAT_MS=30000
WORKER_SHUTDOWN_TIMEOUT_MS=15000
OUTBOX_POLL_MS=5000
OUTBOX_BATCH_SIZE=20
OUTBOX_CONCURRENCY=4

# --- AI (production: real provider only) ---
AI_PROVIDER=openai
AI_MODEL=gpt-4o-mini
AI_API_KEY=<production-api-key>
AI_BASE_URL=
AI_INPUT_USD_PER_MILLION_TOKENS=0.15
AI_OUTPUT_USD_PER_MILLION_TOKENS=0.60
AI_MAX_OUTPUT_TOKENS=500
AI_MAX_INPUT_LENGTH=10000
AI_MAX_COST_CENTS=1000
AI_TIMEOUT_MS=30000

# --- Email and alerting ---
EMAIL_PROVIDER=resend
RESEND_API_KEY=<production-resend-key>
RESEND_FROM=<verified-production-sender>
ALERT_WEBHOOK_URL=https://alerts.example.com/leadops

# --- OpenTelemetry ---
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com:4318
OTEL_SERVICE_NAME=leadops-portal
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
```

Generate secrets:

```bash
openssl rand -hex 32   # LEADOPS_ENCRYPTION_KEY
openssl rand -base64 32 # BETTER_AUTH_SECRET
```

**Never** commit these to version control. Use a secrets manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault, or your platform's native secret injection).

## Security Configuration

### Content Security Policy (CSP)

Configure in `apps/web/next.config.ts` or via reverse proxy headers:

```text
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  font-src 'self';
  connect-src 'self';
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
```

### HTTP Strict Transport Security (HSTS)

```text
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

### CORS

The API accepts cross-origin requests only from the configured `BETTER_AUTH_URL` origin. Additional allowed origins must be explicitly configured. n8n webhooks use signed HMAC authentication, not CORS.

### Additional security headers

```text
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 0
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

### Rate limiting

| Endpoint | Limit |
|----------|-------|
| `/api/v1/events` (webhook) | 100 req/s per integration |
| `/api/v1/auth/*` (login) | 5 req/min per IP |
| `/api/v1/*` (general API) | 60 req/min per session |

### Secrets management

- Rotate `BETTER_AUTH_SECRET` every 90 days (invalidates all sessions).
- Rotate `LEADOPS_ENCRYPTION_KEY` with a re-encryption migration.
- Store API keys in a secrets manager, never in environment files on disk.
- Database credentials should use short-lived certificates where possible.

## Resource Requirements

| Component | CPU | Memory | Disk | Notes |
|-----------|-----|--------|------|-------|
| Web (per instance) | 1 vCPU | 512 MB | — | Next.js SSR; scale horizontally |
| Worker (per instance) | 1 vCPU | 512 MB | — | pg-boss polling; scale horizontally |
| PostgreSQL | 2 vCPU | 4 GB | 50 GB+ | Provisioned IOPS recommended for production |
| OTLP Collector | 1 vCPU | 512 MB | 20 GB | Retain traces for 7 days minimum |

**Scaling guidance:**

- Web: scale based on request latency and 5xx rate. Start with 2 instances.
- Worker: scale based on queue depth (`pgboss.job` count where `state = 'active'`). Start with 1 instance.
- Both are stateless and can scale to zero during inactivity windows if desired.

## Build

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Build outputs:
- `apps/web/.next/` — Next.js production build
- `apps/worker/dist/` — compiled TypeScript (entry: `dist/index.js`)
- `packages/*/dist/` — compiled library packages

## Database Migration Procedure

**Critical: Migration is serial and blocks rollout. Never run migrations concurrently with a running app.**

### Step 1: Stop Web and Worker

```bash
# Kubernetes
kubectl scale deployment leadops-web leadops-worker --replicas=0

# systemd
systemctl stop leadops-web leadops-worker

# Docker Compose
docker compose stop web worker
```

Wait for graceful shutdown (up to `WORKER_SHUTDOWN_TIMEOUT_MS`, default 15s in production).

Verify all instances are stopped:

```bash
kubectl get pods -l app in (leadops-web,leadops-worker) --no-headers | grep -v Terminating || echo "all stopped"
```

### Step 2: Take a pre-migration backup

```bash
pg_dump "$DATABASE_OWNER_URL" --no-owner --no-acl --format=custom \
  > "pre_migration_$(date -u +%Y%m%d_%H%M%S).dump"
```

### Step 3: Run migrations

```bash
DATABASE_OWNER_URL=<prod-owner-url> pnpm db:migrate
```

### Step 4: Verify migration

```bash
# Re-run — should report "schema is up to date"
DATABASE_OWNER_URL=<prod-owner-url> pnpm db:migrate
```

Expected output:

```
migrations applied: 0, skipped: N
schema is up to date
```

Exit code 0 = success. **Any non-zero exit code must block rollout.**

If migration fails:
- **Do not** start Web or Worker.
- Roll back to the previous app version immediately (see Rollback).
- Restore from pre-migration backup if the migration left the schema in an inconsistent state.
- Investigate the migration failure before re-attempting.

### Step 5: Deploy Web and Worker

Only proceed after Step 4 passes.

```bash
# Kubernetes (rolling update)
kubectl set image deployment/leadops-web web=leadops-portal:${VERSION}
kubectl set image deployment/leadops-worker worker=leadops-portal:${VERSION}

# systemd
systemctl start leadops-web leadops-worker
```

## Web Deployment

### Containerized (recommended)

```bash
docker build --target web -t leadops-portal:${VERSION} .
docker push leadops-portal:${VERSION}

# Deploy (example with Kubernetes)
kubectl set image deployment/leadops-web web=leadops-portal:${VERSION}
kubectl rollout status deployment/leadops-web --timeout=120s
```

### Direct Node (alternative)

```bash
cd apps/web
NODE_ENV=production node node_modules/.bin/next start --port 3000
```

### Health endpoints

| Endpoint | Port | Purpose | Probe type |
|----------|------|---------|------------|
| `GET /api/v1/health/live` | 3000 | Process alive | Liveness |
| `GET /api/v1/health/ready` | 3000 | DB reachable | Readiness |
| `GET /api/v1/health` | 3000 | Full health | Startup |

Kubernetes probe configuration:

```yaml
livenessProbe:
  httpGet:
    path: /api/v1/health/live
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 15

readinessProbe:
  httpGet:
    path: /api/v1/health/ready
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10

startupProbe:
  httpGet:
    path: /api/v1/health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 30
```

## Worker Deployment

### Containerized

```bash
docker build --target worker -t leadops-portal:${VERSION} .
kubectl set image deployment/leadops-worker worker=leadops-portal:${VERSION}
kubectl rollout status deployment/leadops-worker --timeout=120s
```

### Health verification

Worker health is verified through:

1. **Heartbeat**: Logs emit heartbeat entries at `WORKER_HEARTBEAT_MS` intervals.
2. **pg-boss registration**: Query `pgboss.job` to confirm queues are registered.
3. **Queue backlog**: Monitor `pgboss.job` where `state = 'created'` — sustained growth indicates a problem.

```sql
-- Check registered queues
SELECT DISTINCT name, state, count(*) FROM pgboss.job GROUP BY name, state ORDER BY name, state;

-- Check for stalled jobs (active but not completing)
SELECT count(*) FROM pgboss.job WHERE state = 'active';
```

## Health Check Verification

After deploying both units, run this smoke test:

```bash
# Web liveness
curl -sf https://app.example.com/api/v1/health/live && echo "LIVE: OK"

# Web readiness
curl -sf https://app.example.com/api/v1/health/ready && echo "READY: OK"

# API health
curl -sf https://app.example.com/api/v1/health && echo "API: OK"

# Webhook health (no auth required for liveness)
curl -sf https://app.example.com/api/v1/health/live && echo "WEBHOOK LIVE: OK"
```

## Monitoring Setup

### OpenTelemetry (OTLP)

The project uses `@leadops/observability` which instruments:

- HTTP requests (Web)
- PostgreSQL queries
- pg-boss job execution
- AI provider calls

Configure the OTLP collector endpoint:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com:4318
OTEL_SERVICE_NAME=leadops-portal
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
```

### Key metrics to alert on

| Metric | Threshold | Severity |
|--------|-----------|----------|
| HTTP 5xx rate | > 1% for 5 min | P1 |
| Webhook signature failures | Sudden spike | P2 |
| Queue backlog (pg-boss created jobs) | > 100 for 10 min | P2 |
| Dead letter queue size | > 0 | P3 |
| Approval delivery failures | > 3 consecutive | P1 |
| Database connection failures | Any | P1 |
| AI provider errors | > 5% for 5 min | P2 |
| Worker heartbeat loss | > 2 intervals | P1 |

### Logging

Structured JSON logs via Pino at `LOG_LEVEL=info`. In production, ship logs to your observability platform. Ensure:

- PII and secrets are redacted (configured in the observability package)
- Correlation IDs (`correlationId`) are preserved across request → event → job → callback chains
- Log sampling is configured for high-traffic endpoints

### Dashboard essentials

Create a production dashboard with these panels:

1. **Request rate** (Web) — requests per second by status code
2. **p95 latency** (Web) — 95th percentile response time
3. **Queue depth** (Worker) — pg-boss jobs by state over time
4. **AI cost** (Worker) — cumulative estimated cost by provider/model
5. **Approval throughput** — approvals created vs delivered per hour
6. **Database connections** — active/idle connection count
7. **Event ingest rate** — webhook events received per minute

## Backup Scheduling

### Automated backups

| Item | Frequency | Retention | Tool |
|------|-----------|-----------|------|
| Full database dump | Daily at 02:00 UTC | 14 days | `pg_dump` or managed provider |
| WAL archiving | Continuous | 7 days | PostgreSQL Archive Command / managed provider |
| Pre-migration snapshot | Every deploy | 30 days | `pg_dump` triggered by CI/CD pipeline |

Managed PostgreSQL providers (AWS RDS, GCP Cloud SQL, Supabase) handle automated backups. Verify retention settings match the table above.

### Backup command

```bash
pg_dump "$DATABASE_OWNER_URL" \
  --no-owner \
  --no-acl \
  --format=custom \
  --compress=9 \
  > "leadops_backup_$(date -u +%Y%m%d_%H%M%S).dump"
```

### Restore procedure

```bash
# 1. Create a fresh empty database
createdb leadops_restore_test

# 2. Restore
pg_restore --dbname=postgresql://leadops_owner:<password>@<host>:5432/leadops_restore_test \
  --no-owner --no-acl --clean --if-exists \
  leadops_backup_YYYYMMDD_HHMMSS.dump

# 3. Run migrations to ensure schema is current
DATABASE_OWNER_URL=postgresql://leadops_owner:<password>@<host>:5432/leadops_restore_test \
  pnpm db:migrate

# 4. Verify: check row counts on key tables
psql "$DATABASE_OWNER_URL" -c "
  SELECT 'organizations' AS tbl, count(*) FROM organizations
  UNION ALL SELECT 'users', count(*) FROM users
  UNION ALL SELECT 'business_events', count(*) FROM business_events
  UNION ALL SELECT 'approvals', count(*) FROM approvals;
"
```

**Perform a restoration drill at least once before accepting paying customers.** Record RTO (Recovery Time Objective) and RPO (Recovery Point Objective).

## Rollback Procedure

### Application rollback (schema unchanged)

If the database migration was successful but the application is faulty:

```bash
# 1. Scale down new version
kubectl scale deployment leadops-web leadops-worker --replicas=0

# 2. Deploy previous version
kubectl set image deployment/leadops-web web=leadops-portal:${PREVIOUS_VERSION}
kubectl set image deployment/leadops-worker worker=leadops-portal:${PREVIOUS_VERSION}

# 3. Scale up
kubectl scale deployment leadops-web leadops-worker --replicas=${DESIRED_COUNT}

# 4. Verify health
curl -sf https://app.example.com/api/v1/health/ready
```

### Database rollback (forward-fix preferred)

Drizzle migrations are forward-only. If a migration introduced a bug:

1. **Preferred**: Write and deploy a new forward migration that fixes the issue.
2. **Manual override**: If forward-fix is impossible:
   - Stop all app instances.
   - Restore the pre-migration backup (taken in Step 2 of deployment).
   - Deploy the previous application version.
   - Run `pnpm db:migrate` with the previous version's migrations.

**Never** manually edit the production schema outside migrations. **Never** run migrations from multiple versions against the same database.

### Emergency rollback checklist

- [ ] Stop all Web and Worker instances
- [ ] Pause pg-boss job processing (stop worker replicas)
- [ ] Take a forensic backup: `pg_dump "$DATABASE_OWNER_URL" > forensic_$(date -u +%s).dump`
- [ ] Determine if schema changes were applied
- [ ] If schema changed: restore pre-migration backup
- [ ] Deploy previous application version
- [ ] Verify health checks pass
- [ ] Resume Worker instances
- [ ] Communicate status to stakeholders
- [ ] Post-incident review within 24 hours

## Dockerfile Reference

The project uses a multi-stage Dockerfile with three build targets. Create `Dockerfile` at the repository root:

```dockerfile
# ---- Base Stage ----
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/events/package.json packages/events/
COPY packages/email/package.json packages/email/
COPY packages/n8n/package.json packages/n8n/
COPY packages/alert/package.json packages/alert/
COPY packages/observability/package.json packages/observability/

RUN pnpm install --frozen-lockfile --prod=false

# ---- Builder Stage ----
FROM base AS builder
COPY . .
RUN pnpm build

# ---- Web Target ----
FROM base AS web
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/next.config.ts ./apps/web/
COPY --from=builder /app/apps/web/package.json ./apps/web/
COPY --from=builder /app/packages/*/dist ./packages/
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/web/node_modules/.bin/next", "start", "--port", "3000"]

# ---- Worker Target ----
FROM base AS worker
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/packages/*/dist ./packages/
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/index.js"]

# ---- Migration Target ----
FROM base AS migration
COPY --from=builder /app/packages/db ./packages/db
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/events/dist ./packages/events/dist
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
CMD ["npx", "tsx", "packages/db/scripts/migrate.ts"]
```

### Building and using targets

```bash
# Build images
docker build --target web       -t leadops-portal:latest-web .
docker build --target worker    -t leadops-portal:latest-worker .
docker build --target migration -t leadops-portal:latest-migration .

# Run migration (must succeed before deploying Web/Worker)
docker run --rm --env-file .env leadops-portal:latest-migration

# Deploy Web and Worker
docker run -d --name leadops-web    -p 3000:3000 --env-file .env leadops-portal:latest-web
docker run -d --name leadops-worker --env-file .env leadops-portal:latest-worker
```

## Expected Timeline

| Step | Duration |
|------|----------|
| CI pipeline (lint, typecheck, test, build) | ~10 min |
| Pre-deploy approval gate | manual |
| Pre-migration backup | ~2 min (depends on DB size) |
| Stop Web + Worker | ~20 sec |
| `pnpm db:migrate` | ~10 sec |
| Verify migration | ~5 sec |
| Deploy Web (rolling update) | ~2 min |
| Deploy Worker (rolling update) | ~1 min |
| Health check verification | ~30 sec |
| Smoke test (E2E quick check) | ~2 min |
| **Total (automated pipeline)** | **~18 min** |
| **Total (with manual gates)** | **~25 min** |
