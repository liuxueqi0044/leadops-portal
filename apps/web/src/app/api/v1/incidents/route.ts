import type postgres from "postgres";
import { getDefaultDatabase, withTenantContext, listIncidentsForTenant } from '@leadops/db';
import { assertCan, incidentsListQuerySchema, incidentsListResponseSchema } from '@leadops/core';
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
    const query = incidentsListQuerySchema.safeParse({
      clientId: url.searchParams.get('clientId') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      severity: url.searchParams.get('severity') ?? undefined,
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
    assertCan(actor, 'incident:read', { organizationId: actor.organizationId, clientId });

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
        return listIncidentsForTenant(txSql, {
          organizationId: actor.organizationId,
          clientId,
          status: query.data.status,
          severity: query.data.severity,
          dateFrom: query.data.dateFrom,
          dateTo: query.data.dateTo,
          limit: query.data.limit ?? 50,
          cursor: query.data.cursor ?? null,
        });
      },
    );

    const body = incidentsListResponseSchema.parse({
      items: result.items.map((i) => ({
        id: i.id,
        organizationId: i.organizationId,
        clientId: i.clientId,
        integrationId: i.integrationId,
        workflowId: i.workflowId,
        fingerprint: i.fingerprint,
        category: i.category,
        severity: i.severity,
        status: i.status,
        occurrenceCount: i.occurrenceCount,
        errorSummary: i.errorSummary,
        firstSeenAt: i.firstSeenAt,
        lastSeenAt: i.lastSeenAt,
        acknowledgedAt: i.acknowledgedAt,
        acknowledgedBy: i.acknowledgedBy,
        resolvedAt: i.resolvedAt,
        resolvedBy: i.resolvedBy,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      })),
      nextCursor: result.nextCursor,
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
