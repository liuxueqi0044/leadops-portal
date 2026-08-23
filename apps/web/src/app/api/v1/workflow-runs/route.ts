import type postgres from 'postgres';
import { getDefaultDatabase, listWorkflowRunsForTenant, withTenantContext } from '@leadops/db';
import { assertCan, workflowRunsListQuerySchema, workflowRunsListResponseSchema } from '@leadops/core';
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
    const query = workflowRunsListQuerySchema.safeParse({
      clientId: url.searchParams.get('clientId') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
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
    assertCan(actor, 'workflow_run:read', { organizationId: actor.organizationId, clientId });

    const handle = getDefaultDatabase();
    const result = await withTenantContext(handle.sql, {
      userId: actor.userId,
      organizationId: actor.organizationId,
      role: actor.role,
      clientId,
    }, async (tx) => listWorkflowRunsForTenant(tx as unknown as postgres.Sql, {
        organizationId: actor.organizationId,
        clientId,
        status: query.data.status,
        dateFrom: query.data.dateFrom,
        dateTo: query.data.dateTo,
        limit: query.data.limit ?? 50,
        cursor: query.data.cursor ?? null,
      }));

    const body = workflowRunsListResponseSchema.parse({
      items: result.items.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        clientId: r.clientId,
        workflowId: r.workflowId,
        externalRunId: r.externalRunId,
        status: r.status,
        startedAt: r.startedAt,
        succeededAt: r.succeededAt,
        failedAt: r.failedAt,
        error: r.error,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      nextCursor: result.nextCursor,
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
