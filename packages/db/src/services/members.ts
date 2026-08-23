import { assertCan, type Actor } from '@leadops/core';
import { createHash, randomBytes } from 'node:crypto';
import type postgres from 'postgres';

import { withTenantContext } from '../tenancy/context.js';
import { withActorContext } from './actor.js';
import { writeAudit } from './audit.js';
import {
  conflict,
  expired,
  forbidden,
  invalid,
  notFound,
} from './errors.js';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const INVITABLE_ROLES = [
  'agency_owner',
  'agency_admin',
  'agency_operator',
  'client_admin',
  'client_viewer',
] as const;

export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Raw token is returned once to the inviter; only its sha256 is stored. */
export function createInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface InvitationRow {
  id: string;
  organizationId: string;
  email: string;
  role: InvitableRole;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface InvitationWithToken extends InvitationRow {
  token: string;
}

export interface InviteOrganizationMemberInput {
  organizationId: string;
  email: string;
  role: InvitableRole;
}

export async function inviteOrganizationMember(
  pool: postgres.Sql,
  actor: Actor,
  input: InviteOrganizationMemberInput,
): Promise<InvitationWithToken> {
  assertCan(actor, 'member:invite', { organizationId: input.organizationId });
  if (!(INVITABLE_ROLES as readonly string[]).includes(input.role)) {
    throw invalid('invalid invitation role');
  }
  const email = normalizeEmail(input.email);
  if (!email) throw invalid('email is required');

  const { token, tokenHash } = createInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  return withActorContext(pool, actor, undefined, async (tx) => {
    const existingMember = await tx.unsafe<{ id: string }[]>(
      `SELECT u.id FROM users u
       JOIN organization_members m ON m."userId" = u.id AND m."organizationId" = $1
       WHERE lower(u.email) = $2`,
      [input.organizationId, email],
    );
    if (existingMember.length > 0) {
      throw conflict('a member with this email already exists');
    }

    const pending = await tx.unsafe<{ id: string }[]>(
      `SELECT id FROM invitations
       WHERE "organizationId" = $1 AND lower(email) = $2 AND status = 'pending'`,
      [input.organizationId, email],
    );
    if (pending.length > 0) {
      throw conflict('a pending invitation for this email already exists');
    }

    await tx.unsafe(
      `INSERT INTO invitations ("organizationId", email, role, "tokenHash", status, "expiresAt", "invitedBy")
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [input.organizationId, email, input.role, tokenHash, expiresAt, actor.userId],
    );

    const rows = await tx.unsafe<InvitationRow[]>(
      `SELECT id, "organizationId", email, role, status, "expiresAt", "createdAt"
       FROM invitations WHERE "tokenHash" = $1`,
      [tokenHash],
    );
    const invitation = rows[0];
    if (!invitation) throw new Error('invitation insert returned no row');

    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'member.invited',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { role: input.role },
    });
    return { ...invitation, token };
  });
}

export interface AcceptInvitationInput {
  userId: string;
  token: string;
}

export interface AcceptedMembership {
  organizationId: string;
  userId: string;
  role: InvitableRole;
}

/**
 * Accepts an invitation: validates the hashed token, expiry, status and
 * email match, then inserts the membership, marks the invitation accepted
 * and writes the audit row in one transaction. All validation is repeated
 * inside the write transaction to stay race-safe.
 */
export async function acceptInvitation(
  pool: postgres.Sql,
  input: AcceptInvitationInput,
): Promise<AcceptedMembership> {
  const tokenHash = hashInvitationToken(input.token.trim());
  const DUMMY_ORG = '00000000-0000-0000-0000-000000000000';

  // Step 1: read the invitation. RLS only reveals rows whose token hash is
  // present in the context, so the organization id is learned from the row.
  const invitation = await withTenantContext(
    pool,
    {
      userId: input.userId,
      organizationId: DUMMY_ORG,
      role: 'client_viewer',
      invitationTokenHash: tokenHash,
    },
    async (tx) => {
      const rows = await tx.unsafe<InvitationRow[]>(
        `SELECT id, "organizationId", email, role, status, "expiresAt", "createdAt"
         FROM invitations WHERE "tokenHash" = $1`,
        [tokenHash],
      );
      return rows[0] ?? null;
    },
  );

  if (!invitation) throw notFound('invitation not found or already used');

  // Step 2: pre-flight checks (re-validated inside the write transaction).
  if (invitation.status === 'accepted') {
    throw conflict('invitation has already been accepted');
  }
  if (invitation.status === 'revoked') {
    throw invalid('invitation has been revoked');
  }
  if (invitation.status === 'expired') {
    throw expired('invitation has expired');
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    throw expired('invitation has expired');
  }

  const user = await pool.unsafe<{ email: string }[]>(
    'SELECT email FROM users WHERE id = $1',
    [input.userId],
  );
  const userEmail = user[0]?.email;
  if (!userEmail) throw notFound('user not found');
  if (normalizeEmail(userEmail) !== normalizeEmail(invitation.email)) {
    throw invalid('invitation email does not match this user');
  }

  // Step 3: write transaction with the real organization context.
  return withTenantContext(
    pool,
    {
      userId: input.userId,
      organizationId: invitation.organizationId,
      role: 'client_viewer',
      invitationTokenHash: tokenHash,
    },
    async (tx) => {
      const fresh = await tx.unsafe<InvitationRow[]>(
        `SELECT id, "organizationId", email, role, status, "expiresAt"
         FROM invitations WHERE "tokenHash" = $1`,
        [tokenHash],
      );
      const row = fresh[0];
      if (row?.status !== 'pending' || row.expiresAt.getTime() < Date.now()) {
        throw conflict('invitation is no longer pending');
      }
      if (normalizeEmail(row.email) !== normalizeEmail(userEmail)) {
        throw invalid('invitation email does not match this user');
      }

      const existing = await tx.unsafe<{ id: string }[]>(
        `SELECT "userId" AS id FROM organization_members
         WHERE "organizationId" = $1 AND "userId" = $2`,
        [invitation.organizationId, input.userId],
      );
      if (existing.length > 0) {
        throw conflict('user is already a member of this organization');
      }

      await tx.unsafe(
        `INSERT INTO organization_members ("organizationId", "userId", role)
         VALUES ($1, $2, $3)`,
        [invitation.organizationId, input.userId, row.role],
      );
      await tx.unsafe(
        `UPDATE invitations SET status = 'accepted', "updatedAt" = now() WHERE id = $1`,
        [row.id],
      );
      await writeAudit(tx, {
        organizationId: invitation.organizationId,
        actorUserId: input.userId,
        action: 'member.invitation_accepted',
        resourceType: 'invitation',
        resourceId: row.id,
        metadata: { role: row.role, targetUserId: input.userId },
      });
      return {
        organizationId: invitation.organizationId,
        userId: input.userId,
        role: row.role,
      };
    },
  );
}

export interface DeactivateMemberInput {
  organizationId: string;
  userId: string;
}

export async function deactivateMember(
  pool: postgres.Sql,
  actor: Actor,
  input: DeactivateMemberInput,
): Promise<void> {
  assertCan(actor, 'member:deactivate', { organizationId: input.organizationId });
  if (input.userId === actor.userId) {
    throw forbidden('cannot deactivate your own membership');
  }

  await withActorContext(pool, actor, undefined, async (tx) => {
    const target = await tx.unsafe<{ role: string }[]>(
      `SELECT role FROM organization_members
       WHERE "organizationId" = $1 AND "userId" = $2`,
      [input.organizationId, input.userId],
    );
    const targetRole = target[0]?.role;
    if (!targetRole) throw notFound('member not found');
    if (
      actor.role === 'agency_admin' &&
      (targetRole === 'agency_owner' || targetRole === 'agency_admin')
    ) {
      throw forbidden('agency_admin cannot deactivate owner or admin members');
    }

    const rows = await tx.unsafe<{ id: string }[]>(
      `UPDATE organization_members
       SET active = false, "updatedAt" = now()
       WHERE "organizationId" = $1 AND "userId" = $2 AND active
       RETURNING "userId" AS id`,
      [input.organizationId, input.userId],
    );
    if (rows.length === 0) throw notFound('active member not found');

    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'member.deactivated',
      resourceType: 'organization_member',
      resourceId: input.userId,
      metadata: { role: targetRole, targetUserId: input.userId },
    });
  });
}

export interface RemoveMemberInput {
  organizationId: string;
  userId: string;
}

export async function removeMember(
  pool: postgres.Sql,
  actor: Actor,
  input: RemoveMemberInput,
): Promise<void> {
  assertCan(actor, 'member:remove', { organizationId: input.organizationId });
  if (input.userId === actor.userId) {
    throw forbidden('cannot remove your own membership');
  }

  await withActorContext(pool, actor, undefined, async (tx) => {
    const target = await tx.unsafe<{ role: string }[]>(
      `SELECT role FROM organization_members
       WHERE "organizationId" = $1 AND "userId" = $2`,
      [input.organizationId, input.userId],
    );
    const targetRole = target[0]?.role;
    if (!targetRole) throw notFound('member not found');
    if (
      actor.role === 'agency_admin' &&
      (targetRole === 'agency_owner' || targetRole === 'agency_admin')
    ) {
      throw forbidden('agency_admin cannot remove owner or admin members');
    }

    const rows = await tx.unsafe<{ id: string }[]>(
      `DELETE FROM organization_members
       WHERE "organizationId" = $1 AND "userId" = $2
       RETURNING "userId" AS id`,
      [input.organizationId, input.userId],
    );
    if (rows.length === 0) throw notFound('member not found');

    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'member.removed',
      resourceType: 'organization_member',
      resourceId: input.userId,
      metadata: { role: targetRole, targetUserId: input.userId },
    });
  });
}

export interface RevokeInvitationInput {
  organizationId: string;
  invitationId: string;
}

export async function revokeInvitation(
  pool: postgres.Sql,
  actor: Actor,
  input: RevokeInvitationInput,
): Promise<void> {
  assertCan(actor, 'member:invite', { organizationId: input.organizationId });
  await withActorContext(pool, actor, undefined, async (tx) => {
    const rows = await tx.unsafe<{ id: string }[]>(
      `UPDATE invitations
       SET status = 'revoked', "updatedAt" = now()
       WHERE id = $1 AND "organizationId" = $2 AND status = 'pending'
       RETURNING id`,
      [input.invitationId, input.organizationId],
    );
    if (rows.length === 0) throw notFound('pending invitation not found');
    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'member.invitation_revoked',
      resourceType: 'invitation',
      resourceId: input.invitationId,
    });
  });
}
