# AI Provider Outage

**Purpose:** Detect and respond when the configured AI qualification provider (OpenAI-compatible) is unavailable, returning errors, or rate-limiting the worker, causing lead qualification jobs to fail repeatedly.

**Expected duration:** 5 minutes to assess and switch; indefinite if waiting for provider recovery.

---

## Background

The worker uses the AI provider for `leads.qualify` jobs (`apps/worker/src/handlers/leads-qualify.ts`). The qualification provider is configured via environment variables:

| Variable | Example |
|---|---|
| `AI_PROVIDER` | `openai` |
| `AI_MODEL` | `gpt-4o-mini` |
| `AI_API_KEY` | `sk-...` |
| `AI_BASE_URL` | `https://api.openai.com/v1` (optional) |
| `AI_TIMEOUT_MS` | `30000` |
| `AI_MAX_OUTPUT_TOKENS` | `500` |

The provider is initialized in `apps/worker/src/qualification-provider.ts:68` via `@ai-sdk/openai`.

---

## Preconditions

- Worker logs are accessible.
- `WORKER_DATABASE_URL` is accessible for querying job state.
- You have a backup AI provider credential or can switch to `fake` mode temporarily.

---

## Stop / Abort Conditions

- Do **not** switch to `AI_PROVIDER=fake` in production — the worker enforces this (`qualification-provider.ts:74`). It is only allowed in `test` and `development` `NODE_ENV`.
- Do **not** bulk-delete `leads.qualify` jobs unless you are certain they cannot be retried successfully.

---

## Step-by-Step Procedure

### 1. Confirm the outage

```powershell
# Check worker logs for AI provider errors:
docker compose logs worker --tail=200 | Select-String "qualif|openai|AI|timeout|rate.?limit|4[0-9][0-9]|5[0-9][0-9]"
```

Key error patterns to look for:
- `401 Unauthorized` — invalid or expired API key
- `429 Too Many Requests` — rate limited by provider
- `500 Internal Server Error` / `503 Service Unavailable` — provider outage
- `TimeoutError` — network connectivity or provider latency exceeding `AI_TIMEOUT_MS`
- `insufficient_quota` — billing/usage limit hit

### 2. Assess the scope

```powershell
$env:DATABASE_OWNER_URL = "postgresql://leadops:leadops_dev@localhost:5432/leadops"
$env:PGPASSWORD = "leadops_dev"

# Check lead qualification backlog:
psql -h localhost -U leadops -d leadops -c @"
SELECT status, count(*)
FROM leads
GROUP BY status;
"@

# Check for recent AI runs with errors:
psql -h localhost -U leadops -d leadops -c @"
SELECT provider, model, status, error_classification, count(*)
FROM ai_runs
WHERE "createdAt" > now() - interval '1 hour'
GROUP BY 1, 2, 3, 4
ORDER BY count(*) DESC;
"@

# Check pg-boss job queue for leads.qualify:
$pgBossSchema = if ($env:PG_BOSS_SCHEMA) { $env:PG_BOSS_SCHEMA } else { "pgboss" }
psql -h localhost -U leadops -d leadops -c @"
SELECT name, state, count(*)
FROM $pgBossSchema.job
WHERE name = 'leads.qualify'
GROUP BY state;
"@
```

### 3. Immediate response

#### If the error is a rate limit (429):

```powershell
# Slow down qualification by reducing outbox concurrency:
$env:OUTBOX_CONCURRENCY = "1"
$env:OUTBOX_BATCH_SIZE = "3"
docker compose up -d worker
```

The retry mechanism (`retryLimit: 10`, `retryDelaySeconds: 5` with backoff) will naturally space out retries.

#### If the error is an auth failure (401):

```powershell
# Rotate the API key immediately — see secret-rotation.md section C.
$env:AI_API_KEY = "<new-key>"
docker compose up -d worker
```

#### If the provider is fully down (500/503/timeout):

Option 1: Switch to an alternative OpenAI-compatible provider:

```powershell
# Set a different AI_BASE_URL (e.g., Azure OpenAI, Anthropic via proxy, etc.):
$env:AI_BASE_URL = "https://your-fallback-proxy.example.com/v1"
$env:AI_API_KEY = "<fallback-key>"
$env:AI_MODEL = "<fallback-model>"
docker compose up -d worker
```

Option 2: Pause qualification processing and let events accumulate safely:

```powershell
# Stop the worker (gracefully):
docker compose stop worker

# The business_events table and outbox will buffer incoming events.
# Leaves will remain in 'received' status.
# When the worker restarts, outbox dispatch resumes and queues are drained.
```

### 4. Monitor recovery

```powershell
# Restart worker if it was stopped:
docker compose up -d worker

# Watch for successful qualifications:
docker compose logs worker -f | Select-String "qualif.*completed|job.success.*leads.qualify"

# Check AI runs table for recent successes:
psql -h localhost -U leadops -d leadops -c @"
SELECT status, count(*)
FROM ai_runs
WHERE "createdAt" > now() - interval '5 minutes'
GROUP BY status;
"@
```

### 5. Handle failed jobs post-recovery

Jobs that exhausted all 10 retries during the outage will have created incidents:

```powershell
# Check for open incidents from qualification failures:
psql -h localhost -U leadops -d leadops -c @"
SELECT id, severity, title, created_at
FROM incidents
WHERE status = 'open'
  AND title LIKE '%leads.qualify%'
ORDER BY created_at DESC
LIMIT 20;
"@

# Re-enqueue failed leads for qualification via the API or by directly updating lead status:
psql -h localhost -U leadops -d leadops -c @"
UPDATE leads
SET status = 'received',
    "qualifiedAt" = NULL,
    "updatedAt" = now()
WHERE status = 'failed'
  AND "createdAt" > now() - interval '24 hours';
"@
```

Then trigger reprojection. Events will be picked up by the outbox dispatcher and re-enqueued.

---

## Verification

1. `docker compose logs worker | Select-String "leads.qualify"` shows successful completions.
2. `ai_runs` table shows `status = 'completed'` for recent rows.
3. `pgboss.job` queue depth for `leads.qualify` is decreasing.
4. No new `error_classification` entries in `ai_runs`.
5. `/api/health/ready` returns 200.

---

## Rollback Path

When the primary provider recovers:

```powershell
# Restore original configuration:
$env:AI_PROVIDER = "openai"
$env:AI_BASE_URL = ""  # or original value
$env:AI_API_KEY = "<original-key>"
$env:AI_MODEL = "<original-model>"
docker compose up -d worker
```

---

## Prevention

- Configure a fallback `AI_BASE_URL` pointing to a secondary provider endpoint.
- Set up monitoring alerts on `ai_runs` error rate > 10% over 5 minutes.
- Monitor `pgboss.job` retry counts for `leads.qualify` exceeding threshold.
- Pre-provision backup API keys with a different provider.
