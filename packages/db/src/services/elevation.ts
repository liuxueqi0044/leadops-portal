import type { Actor } from '@leadops/core';
import type postgres from 'postgres';

import { withTenantContext } from '../tenancy/context.js';
import { requireActiveMembership } from './actor.js';
import { writeAudit } from './audit.js';
import { forbidden, notFound } from './errors.js';

export interface RequestElevationInput {
  userId: string;
  targetOrganizationId: string;
  reason: string;
}

/**
 * Explicit, audited platform elevation. The caller must carry the
 * server-side platform_admin flag, must be an ACTIVE member of the target
 * organization, and the elevation is scoped to that organization only and
 * to this request (nothing is persisted besides the audit entry).
 */
export async function requestElevation(
  pool: postgres.Sql,
  input: RequestElevationInput,
): Promise<Actor> {
  const flagRows = await pool.unsafe<{ platform_admin: boolean }[]>(
    'SELECT platform_admin FROM users WHERE id = $1',
    [input.userId],
  );
  const flag = flagRows[0];
  if (!flag) throw notFound('user not found');
  if (!flag.platform_admin) {
    throw forbidden('user is not a platform admin');
  }

  const membership = await requireActiveMembership(pool, {
    userId: input.userId,
    organizationId: input.targetOrganizationId,
  });
  if (!membership.active) {
    throw forbidden('platform admin must be an active member of the target organization');
  }

  await withTenantContext(
    pool,
    { userId: input.userId, organizationId: input.targetOrganizationId, role: 'platform_admin' },
    async (tx) => {
      await writeAudit(tx, {
        organizationId: input.targetOrganizationId,
        actorUserId: input.userId,
        action: 'platform_admin.elevated',
        resourceType: 'organization',
        resourceId: input.targetOrganizationId,
        metadata: { reason: input.reason },
      });
    },
  );

  return {
    userId: input.userId,
    organizationId: input.targetOrganizationId,
    role: 'platform_admin',
    elevated: true,
    assignedClientIds: [],
  };
}
