import type { TenantTransaction } from '../tenancy/context.js';

export const AUDIT_ACTIONS = [
  'organization.created',
  'organization.updated',
  'member.invited',
  'member.invitation_accepted',
  'member.invitation_revoked',
  'member.deactivated',
  'member.removed',
  'client.created',
  'client.updated',
  'client.member_added',
  'client.member_removed',
  'client.operator_assigned',
  'client.operator_unassigned',
  'platform_admin.elevated',
  'session.organization_switched',
  'integration.created',
  'integration.secret_rotated',
  'integration.revoked',
  'integration.callback_configured',
  'event.replayed',
  'approval.created',
  'approval.decided',
  'approval.token_created',
  'approval.token_revoked',
  'approval.expired',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Whitelist for audit metadata. Tokens, cookies, Authorization headers,
 * complete PII and request bodies are never stored in audit rows.
 */
const ALLOWED_METADATA_KEYS = new Set([
  'reason',
  'role',
  'previousRole',
  'targetUserId',
  'callbackConfigured',
]);

export function sanitizeAuditMetadata(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (ALLOWED_METADATA_KEYS.has(key)) out[key] = input[key];
  }
  return out;
}

export interface AuditRecordInput {
  organizationId: string;
  actorUserId: string;
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  clientId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an audit row on the given transaction connection. Must be called
 * inside the same withTenantContext transaction as the business write so
 * that audit and business succeed or roll back together.
 */
export async function writeAudit(
  tx: TenantTransaction,
  input: AuditRecordInput,
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO audit_logs ("organizationId", "actorUserId", action, "resourceType", "resourceId", "clientId", metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.organizationId,
      input.actorUserId,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.clientId ?? null,
      JSON.stringify(sanitizeAuditMetadata(input.metadata ?? {})),
    ],
  );
}
