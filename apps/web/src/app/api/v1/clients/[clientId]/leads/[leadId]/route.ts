import { getDefaultDatabase, getLeadById, getLeadStatusHistory, withTenantContext } from '@leadops/db';
import { leadDetailDtoSchema, assertCan } from '@leadops/core';
import { getActorFromRequest } from '@/lib/server/actor';
import { handleServiceError } from '@/lib/server/errors';
import type postgres from 'postgres';

function sql(tx: unknown): postgres.Sql {
  return tx as postgres.Sql;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ clientId: string; leadId: string }> },
): Promise<Response> {
  try {
    const actor = await getActorFromRequest(request);
    if (!actor) {
      return Response.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } },
        { status: 401 },
      );
    }

    const { clientId, leadId } = await params;

    assertCan(actor, 'lead:read', { organizationId: actor.organizationId, clientId });

    const handle = getDefaultDatabase();

    const result = await withTenantContext(handle.sql, {
      userId: actor.userId,
      organizationId: actor.organizationId,
      role: actor.role,
      clientId,
    }, async (tx) => {
      const s = sql(tx);
      const lead = await getLeadById(s, {
        leadId,
        organizationId: actor.organizationId,
        clientId,
      });

      if (!lead) return null;

      const history = await getLeadStatusHistory(s, {
        leadId,
        organizationId: actor.organizationId,
        clientId,
      });

      return { lead, history };
    });

    if (!result) {
      return Response.json(
        { error: { code: 'NOT_FOUND', message: 'Lead not found' } },
        { status: 404 },
      );
    }

    const { lead, history } = result;

    const body = leadDetailDtoSchema.parse({
      id: lead.id,
      source: lead.source,
      externalId: lead.externalId,
      status: lead.status,
      contactName: lead.contactName,
      email: lead.email,
      phone: lead.phone,
      company: lead.company,
      message: lead.message,
      score: lead.score,
      aiSuggestion: lead.qualificationDecision
        ? {
            decision: lead.qualificationDecision,
            summary: lead.qualificationSummary,
            suggestedNextAction: lead.suggestedNextAction,
          }
        : null,
      confirmedStatus: lead.status,
      executedBusinessAction: null,
      confidence: lead.qualificationConfidence,
      metadata: lead.metadata,
      receivedAt: lead.receivedAt,
      qualifiedAt: lead.qualifiedAt,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      statusHistory: history.map((h) => ({
        previousStatus: h.previousStatus as string | null,
        newStatus: h.newStatus as string,
        command: h.command as string,
        performedBy: h.performedBy as string,
        createdAt: h.createdAt as string,
      })),
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
