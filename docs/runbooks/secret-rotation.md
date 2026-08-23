# Secret Rotation

**Purpose:** Rotate encryption keys, API credentials, and session secrets used by LeadOps Portal while minimizing service disruption.

**Expected duration:** 15-30 minutes per secret type.

---

## Preconditions

- You have access to the production environment to set new environment variables.
- You have a secure channel to distribute new secrets to deployment.
- For `LEADOPS_ENCRYPTION_KEY` rotation: you have a maintenance window (requires re-encryption of stored secrets).
- For `BETTER_AUTH_SECRET` rotation: accept that all existing user sessions will be invalidated.

---

## Secrets Inventory

| Secret | Purpose | Rotation Impact |
|---|---|---|
| `LEADOPS_ENCRYPTION_KEY` | AES-256-GCM master key for `integration_secrets.encrypted_secret` | All stored secrets must be re-encrypted |
| `BETTER_AUTH_SECRET` | Session cookie signing | All sessions invalidated |
| `AI_API_KEY` | OpenAI/LLM provider API key | AI qualification fails until rotated |
| `DATABASE_OWNER_URL` | Migration superuser connection | No runtime impact |
| `DATABASE_URL` | Runtime application DB connection | Requires app restart |
| `WORKER_DATABASE_URL` | Worker DB connection | Requires worker restart |
| `AI_BASE_URL` | Custom LLM endpoint | If changed, qualification routing changes |

---

## Stop / Abort Conditions

- If `LEADOPS_ENCRYPTION_KEY` is lost or corrupted before re-encryption completes, all `integration_secrets` become permanently unreadable. **Back up the current key before rotation.**
- If the new AI API key does not work, AI qualification will fail for all leads. Pre-validate the key before deploying.

---

## A. Rotating LEADOPS_ENCRYPTION_KEY

### A1. Back up the current key

```powershell
# On the running container/process:
$currentKey = $env:LEADOPS_ENCRYPTION_KEY
Set-Content -Path "leadops-key-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt" -Value $currentKey
Write-Host "Current key backed up to file. Secure this file immediately."
```

### A2. Generate a new key

```powershell
# Generate a 32-byte key as 64 hex characters:
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$newKey = [BitConverter]::ToString($bytes) -replace '-'
Write-Host "New key: $newKey"
```

### A3. Identify secrets that need re-encryption

```powershell
$env:DATABASE_OWNER_URL = "postgresql://leadops:leadops_dev@localhost:5432/leadops"
$env:PGPASSWORD = "leadops_dev"
psql -h localhost -U leadops -d leadops -c "SELECT id, integration_id AS \"integrationId\", version, active_from AS \"activeFrom\" FROM integration_secrets WHERE revoked_at IS NULL;"
```

### A4. Re-encrypt secrets (run after deploying new key)

The application uses `encryptSecret()` from `@leadops/db` (`packages/db/src/services/crypto.ts:28`). Write a one-shot re-encryption script:

```powershell
# Create a temporary re-encryption script:
@'
import postgres from "postgres";
import { decryptSecret, encryptSecret } from "../packages/db/src/services/crypto.js";

const oldKey = process.env.OLD_LEADOPS_ENCRYPTION_KEY;
const newKey = process.env.LEADOPS_ENCRYPTION_KEY;
const dbUrl = process.env.DATABASE_OWNER_URL;

if (!oldKey || !newKey || !dbUrl) {
  console.error("OLD_LEADOPS_ENCRYPTION_KEY, LEADOPS_ENCRYPTION_KEY, and DATABASE_OWNER_URL are required");
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1 });

try {
  const secrets = await sql.unsafe(
    `SELECT id, integration_id, encrypted_secret FROM integration_secrets WHERE revoked_at IS NULL`
  );

  for (const row of secrets) {
    process.env.LEADOPS_ENCRYPTION_KEY = oldKey;
    const plaintext = decryptSecret(row.encrypted_secret);
    process.env.LEADOPS_ENCRYPTION_KEY = newKey;
    const reencrypted = encryptSecret(plaintext);

    await sql.unsafe(
      `UPDATE integration_secrets SET encrypted_secret = $1 WHERE id = $2`,
      [reencrypted, row.id]
    );
    console.log(`Re-encrypted secret for integration ${row.integration_id}`);
  }

  console.log(`Re-encrypted ${secrets.length} secrets`);
} finally {
  await sql.end();
}
'@ | Set-Content -Path scripts/reencrypt-secrets.mjs

# Run with both keys:
$env:OLD_LEADOPS_ENCRYPTION_KEY = $currentKey
$env:LEADOPS_ENCRYPTION_KEY = $newKey
$env:DATABASE_OWNER_URL = "postgresql://leadops:leadops_dev@localhost:5432/leadops"
node scripts/reencrypt-secrets.mjs
```

### A5. Deploy the new key and restart

```powershell
# Set the new key in your deployment environment and restart:
docker compose up -d --force-recreate web worker
```

### A6. Verify and remove backup

```powershell
# Confirm secrets decrypt with new key:
docker compose logs web | Select-String "error"  # Should have no decrypt errors

# Securely delete the backup file:
Remove-Item -Path "leadops-key-backup-*.txt"
```

---

## B. Rotating BETTER_AUTH_SECRET

### B1. Generate a new secret

```powershell
openssl rand -base64 32
```

### B2. Deploy the new secret

```powershell
# Set BETTER_AUTH_SECRET to the new value in your deployment environment
docker compose up -d web
```

### B3. Expected impact

- All existing user sessions are immediately invalidated.
- Users must re-authenticate.
- Inform users in advance if this is a production environment.

### B4. Verify

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/health/live"
# Attempt login flow end-to-end
```

---

## C. Rotating AI_API_KEY

### C1. Generate or obtain a new API key from the provider

OpenAI: https://platform.openai.com/api-keys

### C2. Validate the new key before deploying

```powershell
# Test the new key with a simple completion:
$env:AI_API_KEY = "<new-key>"
# Start worker in dev mode to test qualification:
pnpm --filter @leadops/worker dev
# Observe logs for qualification success
```

### C3. Deploy the new key

```powershell
# Set AI_API_KEY to the new value
docker compose up -d worker
```

### C4. Verify

```powershell
# Watch worker logs:
docker compose logs worker -f | Select-String "qualif"
# Should show successful qualification calls, no auth errors
```

---

## Verification

1. `LEADOPS_ENCRYPTION_KEY`: Integration secrets can be decrypted (no `decrypt` errors in logs).
2. `BETTER_AUTH_SECRET`: Users can log in and receive valid session cookies.
3. `AI_API_KEY`: Worker successfully qualifies leads without authentication errors.
4. Health endpoints return `200` for both web and worker.

---

## Rollback Path

If rotation fails:

1. Revert the environment variable to the previous value.
2. Restart the affected service: `docker compose up -d --force-recreate web worker`
3. If `LEADOPS_ENCRYPTION_KEY` was reverted, re-run the re-encryption script with the old key as `LEADOPS_ENCRYPTION_KEY`.
