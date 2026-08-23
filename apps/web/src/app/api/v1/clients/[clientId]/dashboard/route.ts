import { getDefaultDatabase, getDashboardForTenant } from '@leadops/db';
import { dashboardResponseSchema, dashboardQuerySchema, assertCan } from '@leadops/core';
import { getActorFromRequest } from '@/lib/server/actor';
import { handleServiceError } from '@/lib/server/errors';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<Response> {
  try {
    const actor = await getActorFromRequest(request);
    if (!actor) {
      return Response.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } },
        { status: 401 },
      );
    }

    const { clientId } = await params;

    assertCan(actor, 'dashboard:read', { organizationId: actor.organizationId, clientId });

    const url = new URL(request.url);
    const parsed = dashboardQuerySchema.safeParse({
      dateFrom: url.searchParams.get('dateFrom') ?? undefined,
      dateTo: url.searchParams.get('dateTo') ?? undefined,
    });
    if (!parsed.success) {
      return Response.json(
        { error: { code: 'BAD_REQUEST', message: parsed.error.message } },
        { status: 400 },
      );
    }
    const query = parsed.data;

    const handle = getDefaultDatabase();
    const metrics = await getDashboardForTenant(handle.sql, actor, {
      clientId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });

    const body = dashboardResponseSchema.parse(metrics);
    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
