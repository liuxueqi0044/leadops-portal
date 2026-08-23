import type { Actor, Role } from '@leadops/core';
import type postgres from 'postgres';

import { withTenantContext, type TenantTransaction } from '../tenancy/context.js';
import { invalid, unauthenticated } from './errors.js';

export interface MembershipRow {
  organizationId: string;
  userId: string;
  role: Role;
  active: boolean;
}

const MEMBERSHIP_COLUMNS =
  '"organizationId", "userId", role, active, "createdAt", "updatedAt"';

/**
 * Reads the current membership of a user inside an organization. The context
 * role is a placeholder because the real role is unknown until the membership
 * row is read; RLS only requires a valid context (user/org/role set), and the
 * organization_members policy is context-based, so this lookup is safe.
 */
export async function loadMembership(
  pool: postgres.Sql,
  input: { userId: string; organizationId: string },
): Promise<MembershipRow | null> {
  return withTenantContext(
    pool,
    { userId: input.userId, organizationId: input.organizationId, role: 'client_viewer' },
    async (tx) => {
      const rows = await tx.unsafe<MembershipRow[]>(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM organization_members
         WHERE "organizationId" = $1 AND "userId" = $2`,
        [input.organizationId, input.userId],
      );
      return rows[0] ?? null;
    },
  );
}

export async function requireActiveMembership(
  pool: postgres.Sql,
  input: { userId: string; organizationId: string },
): Promise<MembershipRow> {
  const membership = await loadMembership(pool, input);
  if (!membership) {
    throw invalid('user is not a member of this organization');
  }
  if (!membership.active) {
    throw unauthenticated('user membership has been deactivated');
  }
  return membership;
}

/**
 * Client ids the actor may reach without being agency_owner/admin: operator
 * assignments plus client_admin/client_viewer client memberships. RLS gives
 * owner/admin access to every client in the organization.
 */
export async function loadAccessibleClientIds(
  pool: postgres.Sql,
  input: { userId: string; organizationId: string; role: Role },
): Promise<string[]> {
  return withTenantContext(
    pool,
    { userId: input.userId, organizationId: input.organizationId, role: input.role },
    async (tx) => {
      const rows = await tx.unsafe<{ clientId: string }[]>(
        `SELECT "clientId" FROM client_assignments
         WHERE "userId" = $1 AND "organizationId" = $2
         UNION
         SELECT "clientId" FROM client_members
         WHERE "userId" = $1 AND "organizationId" = $2`,
        [input.userId, input.organizationId],
      );
      return rows.map((r) => r.clientId);
    },
  );
}

export async function isPlatformAdmin(pool: postgres.Sql, userId: string): Promise<boolean> {
  const rows = await pool.unsafe<{ platform_admin: boolean }[]>(
    'SELECT platform_admin FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]?.platform_admin === true;
}

/** Shared transaction body helper for member-scoped service functions. */
export async function withActorContext<T>(
  pool: postgres.Sql,
  actor: Actor,
  clientId: string | undefined,
  callback: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return withTenantContext(
    pool,
    { userId: actor.userId, organizationId: actor.organizationId, role: actor.role, clientId },
    callback,
  );
}
