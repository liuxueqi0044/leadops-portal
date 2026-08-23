import type postgres from 'postgres';

import { withTenantContext } from '../tenancy/context.js';
import { requireActiveMembership } from './actor.js';
import { writeAudit } from './audit.js';
import { unauthenticated } from './errors.js';

export interface SwitchOrganizationInput {
  sessionToken: string;
  userId: string;
  targetOrganizationId: string;
}

export interface SwitchOrganizationResult {
  organizationId: string;
}

/**
 * Organization switching re-validates membership server-side, then updates
 * the session's active_organization_id and writes the audit entry inside a
 * single tenant transaction. If either fails, both are rolled back.
 */
export async function switchOrganization(
  pool: postgres.Sql,
  input: SwitchOrganizationInput,
): Promise<SwitchOrganizationResult> {
  const membership = await requireActiveMembership(pool, {
    userId: input.userId,
    organizationId: input.targetOrganizationId,
  });

  await withTenantContext(
    pool,
    {
      userId: input.userId,
      organizationId: input.targetOrganizationId,
      role: membership.role,
    },
    async (tx) => {
      const rows = await tx.unsafe<{ id: string }[]>(
        `UPDATE sessions
         SET active_organization_id = $1, "updatedAt" = now()
         WHERE token = $2 AND "userId" = $3
         RETURNING id`,
        [input.targetOrganizationId, input.sessionToken, input.userId],
      );
      if (rows.length === 0) {
        throw unauthenticated('session not found');
      }

      await writeAudit(tx, {
        organizationId: input.targetOrganizationId,
        actorUserId: input.userId,
        action: 'session.organization_switched',
        resourceType: 'session',
      });
    },
  );

  return { organizationId: input.targetOrganizationId };
}
