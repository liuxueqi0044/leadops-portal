import type postgres from 'postgres';
import { withIntegrationContext, withTenantContext } from '../tenancy/context.js';
import type { Actor } from '@leadops/core';
import {
  approvalSnapshotSchema,
  generateApprovalToken,
  hashToken,
  type ApprovalRecord,
  type ApprovalSnapshot,
} from '@leadops/core';
import { decryptSecret } from './crypto.js';

export interface CreateApprovalParams {
  organizationId: string;
  clientId: string;
  leadId?: string | null;
  correlationId?: string | null;
  requestVersion?: string | null;
  snapshot: ApprovalSnapshot;
  expiresInSeconds?: number;
  requestedBy?: string;
  integrationId: string;
}

export interface CreateApprovalResult {
  id: string;
  organizationId: string;
  clientId: string;
  status: string;
  version: number;
  isNew: boolean;
  expiresAt: string;
  createdAt: string;
  snapshot: ApprovalSnapshot;
}

export async function createApproval(
  sql: postgres.Sql,
  params: CreateApprovalParams,
): Promise<CreateApprovalResult> {
  const expiresAt = new Date(Date.now() + (params.expiresInSeconds ?? 86400) * 1000).toISOString();
  const correlationId = params.correlationId ?? null;
  const requestVersion = params.requestVersion ?? '1';
  const idempotencySource = correlationId ?? params.leadId;
  if (!idempotencySource) {
    throw new Error('approval leadId or correlationId is required');
  }
  const idempotencyKey = `approval.requested:${idempotencySource}:${requestVersion}`;

  const rows = await sql.unsafe(
    `SELECT aid AS id, oid AS "organizationId", cid AS "clientId",
            st AS status, ver AS version, created AS "isNew"
     FROM create_approval_transactional(
       $1::uuid, $2::uuid, $3::uuid,
       $4, $5,
       (($6::jsonb #>> '{}')::jsonb), $7::timestamptz, $8,
       $9::uuid,
       $10
     )`,
    [
      params.organizationId,
      params.clientId,
      params.leadId ?? null,
      correlationId,
      requestVersion,
      JSON.stringify(params.snapshot),
      expiresAt,
      params.requestedBy ?? 'system',
      params.integrationId,
      idempotencyKey,
    ],
  );

  if (rows.length === 0) {
    throw new Error('approval creation returned no rows');
  }

  const row = rows[0] as Record<string, unknown>;
  const details = await sql.unsafe(
    `SELECT snapshot, expires_at, "createdAt"
     FROM approvals
     WHERE id = $1::uuid
       AND "organizationId" = $2::uuid
       AND "clientId" = $3::uuid`,
    [row.id as string, params.organizationId, params.clientId],
  );
  const detail = details[0] as Record<string, unknown> | undefined;
  if (!detail) throw new Error('approval creation could not be read back');
  const parsedSnapshot = approvalSnapshotSchema.parse(detail.snapshot);

  return {
    id: row.id as string,
    organizationId: row.organizationId as string,
    clientId: row.clientId as string,
    status: row.status as string,
    version: Number(row.version ?? 0),
    isNew: Boolean(row.isNew),
    expiresAt: toIsoString(detail.expires_at),
    createdAt: toIsoString(detail.createdAt),
    snapshot: parsedSnapshot,
  };
}

export interface DecideApprovalParams {
  approvalId: string;
  organizationId: string;
  clientId: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
  reason?: string;
  expectedVersion?: number;
}

export interface DecideApprovalResult {
  id: string;
  organizationId: string;
  clientId: string;
  status: string;
  version: number;
  decided: boolean;
  deliveryId: string | null;
}

export async function decideApproval(
  sql: postgres.Sql,
  params: DecideApprovalParams,
): Promise<DecideApprovalResult> {
  const rows = await sql.unsafe(
    `SELECT aid AS id, oid AS "organizationId", cid AS "clientId",
            st AS status, ver AS version, decided AS decided,
            delivery_id AS "deliveryId"
     FROM decide_approval_atomic(
       $1::uuid, $2::uuid, $3::uuid,
       $4, $5, $6, $7::integer
     )`,
    [
      params.approvalId,
      params.organizationId,
      params.clientId,
      params.decision,
      params.decidedBy,
      params.reason ?? null,
      params.expectedVersion ?? null,
    ],
  );

  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('approval decision returned no rows');
  return {
    id: row.id as string,
    organizationId: row.organizationId as string,
    clientId: row.clientId as string,
    status: row.status as string,
    version: Number(row.version ?? 0),
    decided: Boolean(row.decided),
    deliveryId: (row.deliveryId as string | null) ?? null,
  };
}

export interface CreateApprovalTokenResult {
  token: string;
  tokenId: string;
  expiresAt: string;
}

export async function createApprovalToken(
  sql: postgres.Sql,
  params: {
    approvalId: string;
    organizationId: string;
    clientId: string;
    purpose?: string;
    ttlSeconds?: number;
  },
): Promise<CreateApprovalTokenResult> {
  const { plaintext, hash } = generateApprovalToken();
  const ttl = params.ttlSeconds ?? 86400;
  const approvalRows = await sql.unsafe(
    `SELECT expires_at
     FROM approvals
     WHERE id = $1::uuid
       AND "organizationId" = $2::uuid
       AND "clientId" = $3::uuid
       AND status = 'pending'`,
    [params.approvalId, params.organizationId, params.clientId],
  );
  const approvalRow = approvalRows[0] as Record<string, unknown> | undefined;
  if (!approvalRow) throw new Error('approval token binding is invalid');
  const approvalExpiresAt = new Date(toIsoString(approvalRow.expires_at)).getTime();
  const expiresAt = new Date(Math.min(Date.now() + ttl * 1000, approvalExpiresAt)).toISOString();

  const rows = await sql.unsafe(
    `SELECT tid AS id, tok_hash AS hash
     FROM insert_approval_token_safe(
       $1::uuid, $2::uuid, $3::uuid,
       $4, $5, $6::timestamptz
     )`,
    [
      params.approvalId,
      params.organizationId,
      params.clientId,
      hash,
      params.purpose ?? 'public_decision',
      expiresAt,
    ],
  );

  if (rows.length === 0) {
    throw new Error('approval token insertion returned no rows');
  }

  return {
    token: plaintext,
    tokenId: (rows[0] as Record<string, unknown>).id as string,
    expiresAt,
  };
}

export interface TokenLookupResult {
  approvalId: string | null;
  status: string | null;
  tokenStatus: string;
  snapshot: ApprovalSnapshot | null;
  expiresAt: string | null;
}

export async function lookupApprovalByToken(
  sql: postgres.Sql,
  tokenPlaintext: string,
): Promise<TokenLookupResult> {
  const tokenHashVal = hashToken(tokenPlaintext);

  const rows = await sql.unsafe(
    `SELECT approval_id, approval_status, token_status, snapshot, token_expires_at
     FROM lookup_approval_by_token_hash($1)`,
    [tokenHashVal],
  );

  if (rows.length === 0) {
    return {
      approvalId: null,
      status: null,
      tokenStatus: 'not_found',
      snapshot: null,
      expiresAt: null,
    };
  }

  const row = rows[0] as Record<string, unknown>;
  return {
    approvalId: row.approval_id as string | null,
    status: row.approval_status as string | null,
    tokenStatus: row.token_status as string,
    snapshot: row.snapshot ? approvalSnapshotSchema.parse(row.snapshot) : null,
    expiresAt: row.token_expires_at as string | null,
  };
}

export interface TokenDecideResult {
  approvalId: string;
  status: string;
  version: number;
  tokenStatus: string;
  decided: boolean;
}

export async function consumeTokenAndDecide(
  sql: postgres.Sql,
  tokenPlaintext: string,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  reason?: string,
): Promise<TokenDecideResult> {
  const tokenHashVal = hashToken(tokenPlaintext);

  const rows = await sql.unsafe(
    `SELECT approval_id, org_id, client_id, approval_status,
            approval_version, token_status, decided
     FROM consume_approval_token_and_decide(
       $1, $2, $3, $4
     )`,
    [tokenHashVal, decision, decidedBy, reason ?? null],
  );

  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return {
      approvalId: '',
      status: '',
      version: 0,
      tokenStatus: 'not_found',
      decided: false,
    };
  }
  return {
    approvalId: row.approval_id as string,
    status: row.approval_status as string,
    version: Number(row.approval_version ?? 0),
    tokenStatus: row.token_status as string,
    decided: Boolean(row.decided),
  };
}

export async function revokeApprovalToken(
  sql: postgres.Sql,
  params: {
    tokenPlaintext: string;
    organizationId: string;
    clientId: string;
  },
): Promise<boolean> {
  const tokenHashVal = hashToken(params.tokenPlaintext);

  const rows = await sql.unsafe(
    `SELECT revoke_approval_token_safe($1, $2::uuid, $3::uuid) AS revoked`,
    [tokenHashVal, params.organizationId, params.clientId],
  );

  return Boolean((rows[0] as Record<string, unknown>).revoked);
}

export async function getApprovalById(
  sql: postgres.Sql,
  approvalId: string,
  organizationId: string,
  clientId: string,
): Promise<ApprovalRecord | null> {
  const rows = await sql.unsafe(
    `SELECT id, "organizationId", "clientId", "leadId",
            correlation_id, request_version,
            status, snapshot, expires_at, version,
            requested_by, decided_by, decided_at,
            decision_reason, metadata, "createdAt", "updatedAt"
     FROM approvals
     WHERE id = $1::uuid
       AND "organizationId" = $2::uuid
       AND "clientId" = $3::uuid`,
    [approvalId, organizationId, clientId],
  );

  if (rows.length === 0) return null;
  return mapApprovalRow(rows[0] as Record<string, unknown>);
}

function mapApprovalRow(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: row.id as string,
    organizationId: row.organizationId as string,
    clientId: row.clientId as string,
    leadId: (row.leadId as string) || null,
    correlationId: (row.correlation_id as string) || null,
    requestVersion: (row.request_version as string) || null,
    status: row.status as ApprovalRecord['status'],
    snapshot: approvalSnapshotSchema.parse(row.snapshot),
    expiresAt: toIsoString(row.expires_at),
    version: Number(row.version ?? 1),
    requestedBy: (row.requested_by as string) || null,
    decidedBy: (row.decided_by as string) || null,
    decidedAt: row.decided_at ? toIsoString(row.decided_at) : null,
    decisionReason: (row.decision_reason as string) || null,
    metadata: row.metadata as Record<string, unknown> | null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

export async function getApprovalForTenant(
  pool: postgres.Sql,
  actor: Actor,
  approvalId: string,
): Promise<ApprovalRecord | null> {
  return withTenantContext(pool, actor, async (tx) => {
    const rows = await tx.unsafe(
      `SELECT id, "organizationId", "clientId", "leadId",
              correlation_id, request_version,
              status, snapshot, expires_at, version,
              requested_by, decided_by, decided_at,
              decision_reason, metadata, "createdAt", "updatedAt"
       FROM approvals
       WHERE id = $1::uuid
         AND "organizationId" = $2::uuid`,
      [approvalId, actor.organizationId],
    );
    const row = rows[0];
    return row ? mapApprovalRow(row as Record<string, unknown>) : null;
  });
}

export interface ListApprovalsParams {
  organizationId: string;
  clientId: string;
  status?: ApprovalRecord['status'];
  cursor?: string | null;
  limit: number;
}

export interface ListApprovalsResult {
  items: ApprovalRecord[];
  nextCursor: string | null;
}

export async function listApprovalsForTenant(
  sql: postgres.Sql,
  params: ListApprovalsParams,
): Promise<ListApprovalsResult> {
  let cursorUpdatedAt: string | null = null;
  let cursorId: string | null = null;
  if (params.cursor) {
    const decoded = Buffer.from(params.cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    cursorUpdatedAt = decoded.slice(0, separator);
    cursorId = decoded.slice(separator + 1);
  }

  const rows = await sql.unsafe(
    `SELECT id, "organizationId", "clientId", "leadId",
            correlation_id, request_version,
            status, snapshot, expires_at, version,
            requested_by, decided_by, decided_at,
            decision_reason, metadata, "createdAt", "updatedAt"
     FROM approvals
     WHERE "organizationId" = $1::uuid
       AND "clientId" = $2::uuid
       AND ($3::varchar IS NULL OR status = $3::varchar)
       AND (
         $4::timestamptz IS NULL
         OR ("updatedAt", id) < ($4::timestamptz, $5::uuid)
       )
     ORDER BY "updatedAt" DESC, id DESC
     LIMIT $6`,
    [
      params.organizationId,
      params.clientId,
      params.status ?? null,
      cursorUpdatedAt,
      cursorId,
      params.limit + 1,
    ],
  );

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const items = pageRows.map((row) => mapApprovalRow(row as Record<string, unknown>));
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last
        ? Buffer.from(`${last.updatedAt}|${last.id}`, 'utf8').toString('base64url')
        : null,
  };
}

export interface ClaimedApprovalDelivery {
  id: string;
  approvalId: string;
  organizationId: string;
  clientId: string;
  integrationId: string;
  messageType: string;
  attemptCount: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  callbackUrl: string | null;
  secret: string | null;
}

export async function claimApprovalDeliveries(
  sql: postgres.Sql,
  workerId: string,
  batchSize = 10,
): Promise<ClaimedApprovalDelivery[]> {
  const rows = await sql.unsafe(
    `SELECT id, "approvalId", "organizationId", "clientId", "integrationId",
            message_type AS "messageType", attempt_count AS "attemptCount",
            max_attempts AS "maxAttempts", payload,
            idempotency_key AS "idempotencyKey", callback_url AS "callbackUrl",
            encrypted_secret AS "encryptedSecret"
     FROM claim_approval_delivery_items($1, $2)`,
    [workerId, batchSize],
  );

  return rows.map((value) => {
    const row = value as Record<string, unknown>;
    const encryptedSecret = row.encryptedSecret;
    return {
      id: row.id as string,
      approvalId: row.approvalId as string,
      organizationId: row.organizationId as string,
      clientId: row.clientId as string,
      integrationId: row.integrationId as string,
      messageType: row.messageType as string,
      attemptCount: Number(row.attemptCount),
      maxAttempts: Number(row.maxAttempts),
      payload: row.payload as Record<string, unknown>,
      idempotencyKey: row.idempotencyKey as string,
      callbackUrl: (row.callbackUrl as string | null) ?? null,
      secret:
        typeof encryptedSecret === 'string' && encryptedSecret.length > 0
          ? decryptSecret(encryptedSecret)
          : null,
    };
  });
}

export async function markApprovalDeliveryDelivered(
  sql: postgres.Sql,
  deliveryId: string,
  workerId: string,
): Promise<boolean> {
  const rows = await sql.unsafe(
    'SELECT mark_approval_delivery_delivered($1::uuid, $2) AS updated',
    [deliveryId, workerId],
  );
  return Boolean((rows[0] as Record<string, unknown> | undefined)?.updated);
}

export async function markApprovalDeliveryFailed(
  sql: postgres.Sql,
  deliveryId: string,
  workerId: string,
  error: string,
  retryable: boolean,
): Promise<boolean> {
  const rows = await sql.unsafe(
    'SELECT mark_approval_delivery_failed($1::uuid, $2, $3, $4) AS updated',
    [deliveryId, workerId, error.slice(0, 2000), retryable],
  );
  return Boolean((rows[0] as Record<string, unknown> | undefined)?.updated);
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString();
  }
  return String(value);
}

export interface CreateApprovalForActorParams {
  clientId: string;
  leadId?: string;
  correlationId?: string;
  requestVersion?: string;
  snapshot: ApprovalSnapshot;
  expiresInSeconds?: number;
  generateToken?: boolean;
}

export async function createApprovalForTenant(
  pool: postgres.Sql,
  actor: Actor,
  integrationId: string,
  params: CreateApprovalForActorParams,
): Promise<CreateApprovalResult & { token?: string; tokenExpiresAt?: string }> {
  return withTenantContext(pool, actor, async (tx) => {
    const result = await createApproval(tx as unknown as postgres.Sql, {
      organizationId: actor.organizationId,
      clientId: params.clientId,
      leadId: params.leadId ?? null,
      correlationId: params.correlationId ?? null,
      requestVersion: params.requestVersion,
      snapshot: params.snapshot,
      expiresInSeconds: params.expiresInSeconds,
      requestedBy: actor.userId,
      integrationId,
    });

    let token: string | undefined;
    let tokenExpiresAt: string | undefined;

    if (params.generateToken && result.isNew) {
      const tokenResult = await createApprovalToken(tx as unknown as postgres.Sql, {
        approvalId: result.id,
        organizationId: result.organizationId,
        clientId: result.clientId,
        ttlSeconds: params.expiresInSeconds,
      });
      token = tokenResult.token;
      tokenExpiresAt = tokenResult.expiresAt;
    }

    return { ...result, token, tokenExpiresAt };
  });
}

export async function createApprovalForIntegration(
  pool: postgres.Sql,
  binding: { integrationId: string; organizationId: string; clientId: string },
  params: Omit<CreateApprovalForActorParams, 'clientId'>,
): Promise<CreateApprovalResult & { token?: string; tokenExpiresAt?: string }> {
  return withIntegrationContext(pool, binding, async (tx) => {
    const scoped = tx as unknown as postgres.Sql;
    const result = await createApproval(scoped, {
      organizationId: binding.organizationId,
      clientId: binding.clientId,
      integrationId: binding.integrationId,
      leadId: params.leadId ?? null,
      correlationId: params.correlationId ?? null,
      requestVersion: params.requestVersion,
      snapshot: params.snapshot,
      expiresInSeconds: params.expiresInSeconds,
      requestedBy: `integration:${binding.integrationId}`,
    });

    if (!params.generateToken || !result.isNew) return result;
    const token = await createApprovalToken(scoped, {
      approvalId: result.id,
      organizationId: binding.organizationId,
      clientId: binding.clientId,
      ttlSeconds: params.expiresInSeconds,
    });
    return {
      ...result,
      token: token.token,
      tokenExpiresAt: token.expiresAt,
    };
  });
}

export interface ExpiredApprovalRow {
  approval_id: string;
  was_expired: boolean;
}

export async function expireApprovalsForTenant(
  sql: postgres.Sql,
  organizationId: string,
  clientId: string,
  integrationId: string,
): Promise<ExpiredApprovalRow[]> {
  const rows = await sql.unsafe(
    `SELECT approval_id, was_expired
     FROM expire_pending_approvals_for_integration($1::uuid, $2::uuid, $3::uuid)`,
    [organizationId, clientId, integrationId],
  );
  return rows as unknown as ExpiredApprovalRow[];
}

export async function claimApprovalDeliveryExact(
  sql: postgres.Sql,
  params: {
    deliveryId: string;
    organizationId: string;
    clientId: string;
    integrationId: string;
    workerId: string;
  },
): Promise<ClaimedApprovalDelivery | null> {
  const rows = await sql.unsafe(
    `SELECT id, "approvalId", "organizationId", "clientId", "integrationId",
            message_type AS "messageType", attempt_count AS "attemptCount",
            max_attempts AS "maxAttempts", payload,
            idempotency_key AS "idempotencyKey", callback_url AS "callbackUrl",
            encrypted_secret AS "encryptedSecret"
     FROM claim_approval_delivery_exact(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5
     )`,
    [
      params.deliveryId,
      params.organizationId,
      params.clientId,
      params.integrationId,
      params.workerId,
    ],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const encryptedSecret = row.encryptedSecret;
  return {
    id: row.id as string,
    approvalId: row.approvalId as string,
    organizationId: row.organizationId as string,
    clientId: row.clientId as string,
    integrationId: row.integrationId as string,
    messageType: row.messageType as string,
    attemptCount: Number(row.attemptCount),
    maxAttempts: Number(row.maxAttempts),
    payload: row.payload as Record<string, unknown>,
    idempotencyKey: row.idempotencyKey as string,
    callbackUrl: (row.callbackUrl as string | null) ?? null,
    secret:
      typeof encryptedSecret === 'string' && encryptedSecret.length > 0
        ? decryptSecret(encryptedSecret)
        : null,
  };
}

export async function decideApprovalForTenant(
  pool: postgres.Sql,
  actor: Actor,
  params: {
    approvalId: string;
    clientId: string;
    decision: 'approved' | 'rejected';
    reason?: string;
    expectedVersion?: number;
  },
): Promise<DecideApprovalResult> {
  return withTenantContext(pool, actor, async (tx) => {
    return decideApproval(tx as unknown as postgres.Sql, {
      approvalId: params.approvalId,
      organizationId: actor.organizationId,
      clientId: params.clientId,
      decision: params.decision,
      decidedBy: actor.userId,
      reason: params.reason,
      expectedVersion: params.expectedVersion,
    });
  });
}
