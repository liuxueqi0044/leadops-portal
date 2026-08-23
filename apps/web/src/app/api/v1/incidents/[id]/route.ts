import type postgres from "postgres";
import { getDefaultDatabase, withTenantContext, getIncidentForTenant, getIncidentEvents } from '@leadops/db';
import { assertCan, incidentDetailResponseSchema } from '@leadops/core';
import { getActorFromRequest } from '@/lib/server/actor';
import { handleServiceError } from '@/lib/server/errors';
import { z } from 'zod';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const actor = await getActorFromRequest(request);
    if (!actor) {
      return Response.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } },
        { status: 401 },
      );
    }

    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) {
      return Response.json({ error: { code: 'INVALID', message: 'Invalid incident id' } }, { status: 400 });
    }

    const handle = getDefaultDatabase();

    const result = await withTenantContext(
      handle.sql,
      {
        userId: actor.userId,
        organizationId: actor.organizationId,
        role: actor.role,
      },
      async (tx) => {
        const txSql = tx as unknown as postgres.Sql;
        const incident = await getIncidentForTenant(txSql, {
          organizationId: actor.organizationId,
          incidentId: id,
        });

        if (!incident) return null;
        assertCan(actor, 'incident:read', {
          organizationId: actor.organizationId,
          clientId: incident.clientId,
        });

        const events = await getIncidentEvents(txSql, {
          organizationId: actor.organizationId,
          incidentId: id,
        });

        return { incident, events };
      },
    );

    if (!result) {
      return Response.json(
        { error: { code: 'NOT_FOUND', message: 'Incident not found' } },
        { status: 404 },
      );
    }

    const body = incidentDetailResponseSchema.parse({
      id: result.incident.id,
      organizationId: result.incident.organizationId,
      clientId: result.incident.clientId,
      integrationId: result.incident.integrationId,
      workflowId: result.incident.workflowId,
      fingerprint: result.incident.fingerprint,
      category: result.incident.category,
      severity: result.incident.severity,
      status: result.incident.status,
      occurrenceCount: result.incident.occurrenceCount,
      errorSummary: result.incident.errorSummary,
      firstSeenAt: result.incident.firstSeenAt,
      lastSeenAt: result.incident.lastSeenAt,
      acknowledgedAt: result.incident.acknowledgedAt,
      acknowledgedBy: result.incident.acknowledgedBy,
      resolvedAt: result.incident.resolvedAt,
      resolvedBy: result.incident.resolvedBy,
      createdAt: result.incident.createdAt,
      updatedAt: result.incident.updatedAt,
      events: result.events.map((e) => ({
        id: e.id,
        incidentId: e.incidentId,
        organizationId: e.organizationId,
        clientId: e.clientId,
        eventType: e.eventType,
        actor: e.actor,
        correlationId: e.correlationId,
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
