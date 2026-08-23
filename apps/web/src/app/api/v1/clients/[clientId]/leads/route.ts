import { getDefaultDatabase, listLeadsForTenant } from '@leadops/db';
import { leadsListResponseSchema, leadsListQuerySchema, assertCan } from '@leadops/core';
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

    assertCan(actor, 'lead:list', { organizationId: actor.organizationId, clientId });

    const url = new URL(request.url);
    const rawQuery = Object.fromEntries(url.searchParams);
    const parsed = leadsListQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return Response.json(
        { error: { code: 'BAD_REQUEST', message: parsed.error.message } },
        { status: 400 },
      );
    }
    const query = parsed.data;

    const handle = getDefaultDatabase();
    const result = await listLeadsForTenant(handle.sql, actor, {
      clientId,
      limit: query.limit ?? 20,
      cursor: query.cursor ?? null,
      status: query.status,
      minScore: query.minScore,
      maxScore: query.maxScore,
      source: query.source,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });

    const body = leadsListResponseSchema.parse({
      items: result.items.map((l) => ({
        id: l.id,
        source: l.source,
        externalId: l.externalId,
        status: l.status,
        contactName: l.contactName,
        email: l.email,
        phone: l.phone,
        company: l.company,
        score: l.score,
        aiSuggestion: l.qualificationDecision
          ? {
              decision: l.qualificationDecision,
              summary: l.qualificationSummary,
              suggestedNextAction: l.suggestedNextAction,
            }
          : null,
        confirmedStatus: l.status,
        executedBusinessAction: null,
        receivedAt: l.receivedAt,
        qualifiedAt: l.qualifiedAt,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
      nextCursor: result.nextCursor,
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
