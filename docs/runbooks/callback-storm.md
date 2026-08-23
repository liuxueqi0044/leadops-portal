# Callback Storm

**Purpose:** Detect, contain, and recover from a surge of incoming webhook callbacks or outbox messages that overwhelm the system causing queue backpressure, database contention, or worker saturation.

**Expected duration:** 5-15 minutes to contain; full recovery depends on backlog size.

---

## Preconditions

- Monitoring is in place (log aggregation, database metrics).
- You have access to `DATABASE_OWNER_URL` for direct SQL queries.
- Worker logs are accessible.

---

## Symptoms

- Sudden spike in `outbox` `pending` count.
- `pgboss.job` queue depth growing rapidly for `events.project` or downstream jobs.
- Worker logs flooding with `outbox.claimed` at high counts.
- Database CPU or connection count spiking.
- API latency increasing (`business_events` ingest endpoint timing out).
- `claim_outbox_items` taking longer than usual.

---

## Stop / Abort Conditions

- Do **not** drop the `outbox` or `business_events` tables — you will lose audit trail.
- Do **not** set `OUTBOX_CONCURRENCY` too high (> 50) without monitoring database connection limits (default postgres.js pool: `max: 5`).

---

## Step-by-Step Procedure

### 1. Confirm the storm

```powershell
$env:DATABASE_OWNER_URL = "postgresql://leadops:leadops_dev@localhost:5432/leadops"
$env:PGPASSWORD = "leadops_dev"

# Check business_events ingestion rate (last 5 minutes):
psql -h localhost -U leadops -d leadops -c @"
SELECT date_trunc('minute', "receivedAt") AS minute, count(*)
FROM business_events
WHERE "receivedAt" > now() - interval '15 minutes'
GROUP BY 1
ORDER BY 1 DESC;
"@

# Check outbox growth:
psql -h localhost -U leadops -d leadops -c @"
SELECT status, count(*)
FROM outbox
GROUP BY status;
"@

# Check pg-boss queue depth:
$pgBossSchema = if ($env:PG_BOSS_SCHEMA) { $env:PG_BOSS_SCHEMA } else { "pgboss" }
psql -h localhost -U leadops -d leadops -c @"
SELECT name, state, count(*)
FROM $pgBossSchema.job
WHERE state IN ('created', 'retry')
GROUP BY name, state
ORDER BY count(*) DESC;
"@

# Check active database connections:
psql -h localhost -U leadops -d leadops -c "SELECT count(*) AS active_connections FROM pg_stat_activity WHERE state = 'active';"
```

### 2. Identify the source

```powershell
# Which integration/client is sending the most events?
psql -h localhost -U leadops -d leadops -c @"
SELECT "integrationId", "clientId", "eventType", count(*) AS cnt
FROM business_events
WHERE "receivedAt" > now() - interval '15 minutes'
GROUP BY 1, 2, 3
ORDER BY cnt DESC
LIMIT 20;
"@

# Which message types are flooding the outbox?
psql -h localhost -U leadops -d leadops -c @"
SELECT message_type, count(*) AS cnt
FROM outbox
WHERE status = 'pending'
GROUP BY message_type
ORDER BY cnt DESC;
"@
```

### 3. Contain the storm

#### Option A: Pause the callback source (preferred)

If the source is an n8n workflow or external integration you control:

```powershell
# Disable the integration temporarily:
$headers = @{ "Content-Type" = "application/json" }
$body = '{"status":"paused"}' | ConvertFrom-Json
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/integrations/<integrationId>" -Method Patch -Headers $headers -Body ($body | ConvertTo-Json)
```

#### Option B: Rate-limit at the ingress

If the webhook endpoint cannot be controlled at source, add a temporary rate limit:

```powershell
# Set environment variable and restart web:
$env:WEBHOOK_RATE_LIMIT_PER_MINUTE = "10"
docker compose up -d web
```

#### Option C: Throttle the worker (reduce outbox concurrency)

```powershell
# Reduce worker throughput to let the system catch up:
$env:OUTBOX_CONCURRENCY = "1"
$env:OUTBOX_BATCH_SIZE = "5"
$env:OUTBOX_POLL_MS = "30000"
docker compose up -d worker
```

#### Option D: Emergency backpressure via SQL

```sql
-- Defer all pending outbox items by 5 minutes:
UPDATE outbox
SET nextAttemptAt = now() + interval '5 minutes'
WHERE status = 'pending'
  AND nextAttemptAt < now();

-- Or, for a specific message type:
UPDATE outbox
SET nextAttemptAt = now() + interval '10 minutes'
WHERE status = 'pending'
  AND message_type = '<flooding-message-type>'
  AND nextAttemptAt < now();
```

### 4. Drain the backlog

Once the inflow is controlled, accelerate processing:

```powershell
# Increase concurrency to drain backlog faster:
$env:OUTBOX_CONCURRENCY = "8"
$env:OUTBOX_BATCH_SIZE = "30"
$env:OUTBOX_POLL_MS = "2000"
docker compose up -d worker
```

Monitor progress:

```powershell
# Watch outbox pending count decrease:
while ($true) {
  $count = psql -h localhost -U leadops -d leadops -t -c "SELECT count(*) FROM outbox WHERE status = 'pending';"
  Write-Host "$(Get-Date -Format 'HH:mm:ss') - Pending outbox: $count"
  Start-Sleep -Seconds 10
}
```

### 5. Detect duplicate events

Callback storms often produce duplicate webhook events. The system has deduplication via `business_events_integration_webhook_unique` index (unique on `integrationId, webhookId`). Check for duplicates:

```powershell
psql -h localhost -U leadops -d leadops -c @"
SELECT "integrationId", "webhookId", count(*) AS dupes
FROM business_events
WHERE "receivedAt" > now() - interval '1 hour'
GROUP BY 1, 2
HAVING count(*) > 1
ORDER BY dupes DESC
LIMIT 20;
"@
```

If duplicates are being rejected correctly (ON CONFLICT DO NOTHING), this is expected. If duplicates are passing through, check that `webhookId` values are unique per webhook call.

---

## Verification

1. `outbox` `pending` count is trending down.
2. `pgboss.job` queue depth for `events.project` and downstream jobs is decreasing.
3. Worker logs show normal `outbox.claimed` counts (close to `OUTBOX_BATCH_SIZE`).
4. Database CPU and connection count return to baseline.
5. `/api/health/ready` returns 200 with fast response time.
6. No new `failed` events accumulating in `business_events`.

---

## Recovery Completion

When backlog is drained:

```powershell
# Restore normal configuration:
$env:OUTBOX_CONCURRENCY = "4"
$env:OUTBOX_BATCH_SIZE = "10"
$env:OUTBOX_POLL_MS = "5000"
docker compose up -d worker

# Re-enable any paused integrations via API.
```

---

## Prevention Measures

- Add webhook rate limiting per integration.
- Set up alerting on `outbox` pending count > 1000.
- Set up alerting on `business_events` ingestion rate spike (> 3x baseline).
- Ensure callers respect `Retry-After` headers on 429 responses.
- Monitor `pg_stat_activity` connection count.
