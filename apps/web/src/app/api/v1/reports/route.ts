import type postgres from "postgres";
import { getDefaultDatabase, withTenantContext, listReportSnapshotsForTenant } from '@leadops/db';
import { assertCan, reportsListQuerySchema, reportsListResponseSchema } from '@leadops/core';
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
    const query = reportsListQuerySchema.safeParse({
      clientId: url.searchParams.get('clientId') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
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
    assertCan(actor, 'report:read', { organizationId: actor.organizationId, clientId });

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
        return listReportSnapshotsForTenant(txSql, {
          organizationId: actor.organizationId,
          clientId,
          limit: query.data.limit ?? 50,
          dateFrom: query.data.dateFrom,
          dateTo: query.data.dateTo,
          cursor: query.data.cursor ?? null,
        });
      },
    );

    const body = reportsListResponseSchema.parse({
      items: result.items.map((s) => ({
        id: s.id,
        organizationId: s.organizationId,
        clientId: s.clientId,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        generationVersion: s.generationVersion,
        metrics: s.metrics,
        correlationId: s.correlationId,
        generatedAt: s.generatedAt,
        createdAt: s.createdAt,
      })),
      nextCursor: result.nextCursor,
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
