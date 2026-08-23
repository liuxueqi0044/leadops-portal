import type postgres from "postgres";
import { getDefaultDatabase, withTenantContext, computeOperationsDashboard } from '@leadops/db';
import { assertCan, operationsDashboardQuerySchema, operationsDashboardResponseSchema } from '@leadops/core';
import { getActorFromRequest } from '@/lib/server/actor';
import { handleServiceError } from '@/lib/server/errors';

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await getActorFromRequest(request);
    if (!actor) {
      return Response.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } },
        { status: 401 },
      );
    }

    const url = new URL(request.url);
    const query = operationsDashboardQuerySchema.safeParse({
      clientId: url.searchParams.get('clientId') ?? undefined,
      dateFrom: url.searchParams.get('dateFrom') ?? undefined,
      dateTo: url.searchParams.get('dateTo') ?? undefined,
    });

    if (!query.success) {
      return Response.json(
        { error: { code: 'INVALID', message: 'Invalid query parameters', details: query.error.flatten() } },
        { status: 400 },
      );
    }

    const clientId = query.data.clientId ?? actor.assignedClientIds?.[0];
    if (!clientId) {
      return Response.json(
        { error: { code: 'INVALID', message: 'clientId is required' } },
        { status: 400 },
      );
    }
    assertCan(actor, 'dashboard:read', { organizationId: actor.organizationId, clientId });

    const handle = getDefaultDatabase();

    const result = await withTenantContext(
      handle.sql,
      {
        userId: actor.userId,
        organizationId: actor.organizationId,
        role: actor.role,
        clientId,
      },
      async (tx) => {
        const txSql = tx as unknown as postgres.Sql;
        return computeOperationsDashboard(txSql, {
          organizationId: actor.organizationId,
          clientId,
          dateFrom: query.data.dateFrom,
          dateTo: query.data.dateTo,
        });
      },
    );

    const body = operationsDashboardResponseSchema.parse(result);
    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
