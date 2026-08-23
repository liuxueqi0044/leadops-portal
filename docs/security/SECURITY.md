# Security Policy

## Supported Versions

LeadOps Portal V3 is currently in active pre-release development (`0.0.0`). Security patches are applied directly to the `main` branch. Once a stable release is tagged, the following support matrix will apply:

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Do not open a public issue.** Send vulnerability reports to the security team via email (contact your team lead for the current address).

Include in your report:

- Affected component and version
- Steps to reproduce
- Potential impact
- Any suggested remediation (optional)

The team will acknowledge receipt within 48 hours and aim to publish a fix within 7 days for critical issues.

## Security Model Overview

LeadOps Portal V3 is a **multi-tenant lead operations platform** built on PostgreSQL with defense-in-depth at every layer: network, application, and database.

### Row-Level Security (RLS)

Every tenant-scoped table has RLS **enabled and forced** (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY; ALTER TABLE ... FORCE ROW LEVEL SECURITY`). This means even the table owner cannot bypass RLS on these tables.

RLS policies use the runtime GUC variables set by `packages/db/src/tenancy/context.ts`:

| GUC                        | Purpose                                 |
| -------------------------- | --------------------------------------- |
| `app.current_user_id`      | Identifies the acting user              |
| `app.current_organization_id` | Identifies the current tenant scope |
| `app.current_client_id`    | Identifies the current client scope     |
| `app.current_role`         | `platform_admin`, `org_owner`, `org_admin`, `org_readonly`, `client_user` |

Policies follow the pattern:
```sql
CREATE POLICY "tenant_isolation"
  ON some_table
  FOR ALL
  USING ("organizationId" = current_setting('app.current_organization_id')::uuid);
```

### SECURITY DEFINER Functions

Write operations that cross tenant boundaries (worker polling, outbox claims, token lookups) use `SECURITY DEFINER` functions owned by `leadops_owner`. These functions:

1. Validate tenant authorization internally before any mutation
2. Use `FOR UPDATE SKIP LOCKED` for concurrent-safe polling
3. Accept explicit `organizationId`/`clientId` parameters rather than relying on RLS GUCs

Key SECURITY DEFINER functions:

- `claim_outbox_items(integer, text)` — Worker outbox polling
- `mark_outbox_delivered_safe(uuid, text)` — Outbox delivery with lockedBy check
- `lookup_approval_by_token_hash(text)` — Public token-to-approval resolution
- `create_approval_transactional(...)` — Idempotent approval creation
- `decide_approval_atomic(...)` — Version-conditional approval decision
- `prune_non_audit_data(boolean, integer)` — Retention pruning

### Tenant Isolation

The database connection model enforces strict separation:

| Role                    | Privileges                                        | BYPASSRLS |
| ----------------------- | ------------------------------------------------- | --------- |
| `leadops_owner`         | DDL, grants, migration owner                      | No (NOSUPERUSER, NOBYPASSRLS) |
| `leadops_worker`        | SELECT/INSERT/UPDATE on runtime tables, EXECUTE on SECURITY DEFINER functions | No |
| `leadops_worker_test`   | Same as leadops_worker (test schema)              | No |
| `leadops_app`           | Runtime application role; all data access via RLS | No |
| `authenticator`         | Login-only; sets GUCs, then SET ROLE to leadops_app | No |

**No role has BYPASSRLS.** All integration tests verify this at startup via `packages/db/src/test/global-setup.ts:99-110`.

### Organizations, Clients, and Memberships

Multi-tenancy is structured as:

```
Organization
  └── Clients
        └── Client Assignments (service: workflow | integration)
```

- `organization_members` links users to organizations with roles
- `client_members` links users to specific clients within an org
- `client_assignments` binds integrations/workflows to clients
- Invitations use SHA-256 hash tokens (`invitations_token_hash_unique`) — raw tokens are never stored

## Authentication

Authentication is handled by **Better Auth v1.6.25** (`apps/web/src/lib/server/auth.ts`):

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: 'pg' }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
  },
});
```

Better Auth manages:
- `users` — Core user identity (email + password)
- `sessions` — Session tokens with expiration
- `accounts` — OAuth provider accounts (provisioned for future use)
- `verifications` — Email verification tokens

The `users.platform_admin` column is server-authoritative: runtime roles are denied UPDATE on this column via column-level REVOKE in migrations.

## Encryption of Secrets at Rest

Integration secrets (API keys, webhook secrets) are encrypted at rest using **AES-256-GCM** with per-secret key derivation (`packages/db/src/services/crypto.ts`).

### Algorithm

| Parameter    | Value                          |
| ------------ | ------------------------------ |
| Cipher       | AES-256-GCM                    |
| Key size     | 256 bits (32 bytes)            |
| IV           | 12 bytes (random per encrypt)  |
| Auth tag     | 16 bytes                       |
| Salt         | 32 bytes (random per encrypt)  |
| Key derivation | scrypt (Node.js `scryptSync`) |

### Key Management

The master encryption key is read from the `LEADOPS_ENCRYPTION_KEY` environment variable:

- **Format**: 64 hex characters (32 bytes)
- **Validation**: Enforced at startup — malformed keys cause a hard error
- **Redaction**: The key is automatically redacted in all logs via `packages/observability/src/index.ts:20-38` (paths `encryptionKey`, `encryption_key`, `ENCRYPTION_KEY`)

### How Encryption Works

1. A random 32-byte salt is generated for each encryption operation
2. `scryptSync(masterKey, salt, 32)` derives a per-secret key
3. The plaintext is encrypted with a random 12-byte IV
4. The output format is `base64(salt || iv || authTag || ciphertext)`
5. Decryption reverses this: parse the combined buffer, derive the key, decrypt

**Never store raw integration secrets.** Integration creation in `packages/db/src/services/integrations.ts` always encrypts before INSERT into `integration_secrets`.

## HMAC Webhook Verification

Incoming webhooks are verified using the `standardwebhooks` library (`packages/events/src/signing.ts`).

### Verification Flow

1. Required headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`
2. Header format validation:
   - `webhook-id` must match `^[a-zA-Z0-9\-_]{1,200}$`
   - `webhook-timestamp` must be 1-12 digit Unix seconds
   - `webhook-signature` must be `v1,<base64-signature>`
3. Timestamp tolerance: **5 minutes** (±300s)
4. Signatures are checked against all active secrets for the integration (supports secret rotation)
5. **Constant-time comparison** (`timingSafeEqual`) is used to prevent timing attacks
6. Signature failures are counted as `webhook_signature_failures_total` metric

### Webhook Secret Generation

Secrets are generated as `whsec_<32 random bytes as base64>` (`packages/events/src/signing.ts:105-113`). The `whsec_` prefix is used for storage identification; raw secrets are encrypted before database insertion.

### Body Hashing

Webhook request bodies are SHA-256 hashed for deduplication (`computeBodyHash` in `packages/events/src/signing.ts:116-118`). Identical body hashes allow idempotent event processing.

## Token Hashing (SHA-256)

Approval tokens and invitation tokens use SHA-256 hashing — **plaintext tokens are never stored in the database** (`packages/core/src/approval/tokens.ts`).

### Token Lifecycle

1. **Generation**: 32 random bytes → base64url encoded plaintext → SHA-256 hex hash
2. **Storage**: Only the hash is written to `approval_tokens.token_hash` or `invitations.token_hash`
3. **Verification**: Lookup by hash via `lookup_approval_by_token_hash(hash)` SECURITY DEFINER function
4. **Consumption**: One-time use via `consume_approval_token_and_decide(...)` which atomically marks the token used
5. **Timeout**: Tokens have configurable `expires_at`; expired tokens are rejected

### Constant-Time Comparison

Token hash comparison uses `timingSafeEqual` (constant-time). If `timingSafeEqual` throws (e.g., length mismatch), a fallback bitwise XOR loop prevents leaking length information (`packages/core/src/approval/tokens.ts:61-70`).

## Observability Safeguards

Sensitive fields are redacted from all logs via `packages/observability/src/index.ts:4-70`:

- Passwords, secrets, tokens, API keys, cookies, authorization headers
- `LEADOPS_ENCRYPTION_KEY` / `encryptionKey` / `encryption_key`
- Email bodies, HTML bodies, text bodies, subjects
- AI prompt and response attributes in OpenTelemetry spans
