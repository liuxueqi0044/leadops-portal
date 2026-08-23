import { getDefaultDatabase } from '@leadops/db';
import {
  loadAccessibleClientIds,
  requireActiveMembership,
} from '@leadops/db';
import type { Actor } from '@leadops/core';function extractSessionToken(cookieHeader: string): string | null {
  const result = /(?:^|;\s*)better-auth\.session_token=([^;]+)/.exec(cookieHeader);
  return result?.[1] ?? null;
}

export async function getActorFromRequest(request: Request): Promise<Actor | null> {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const token = extractSessionToken(cookieHeader);
  if (!token) return null;

  const handle = getDefaultDatabase();

  const sessions = await handle.sql.unsafe<{
    userId: string;
    activeOrganizationId: string | null;
    expiresAt: string;
  }[]>(
    `SELECT "userId", active_organization_id AS "activeOrganizationId", "expiresAt"
     FROM sessions WHERE token = $1`,
    [token],
  );
  const session = sessions[0];
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  if (!session.activeOrganizationId) return null;

  const membership = await requireActiveMembership(handle.sql, {
    userId: session.userId,
    organizationId: session.activeOrganizationId,
  });

  const clientIds = await loadAccessibleClientIds(handle.sql, {
    userId: session.userId,
    organizationId: session.activeOrganizationId,
    role: membership.role,
  });

  return {
    userId: session.userId,
    organizationId: session.activeOrganizationId,
    role: membership.role,
    assignedClientIds: clientIds,
  };
}
