import type postgres from "postgres";
import {
  acknowledgeIncidentForTenant,
  getDefaultDatabase,
  getIncidentForTenant,
  withTenantContext,
} from '@leadops/db';
import { acknowledgeIncidentRequestSchema, assertCan } from '@leadops/core';
import { getActorFromRequest } from '@/lib/server/actor';
import { handleServiceError } from '@/lib/server/errors';
import { z } from 'zod';

function mutationErrorResponse(error: unknown): Response | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
  if (code === '42501' || message.includes('tenant binding mismatch') || message.includes('tenant access denied')) {
    return Response.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, { status: 403 });
  }
  if (code === '02000' || message.includes('not found')) {
    return Response.json({ error: { code: 'NOT_FOUND', message: 'Incident not found' } }, { status: 404 });
  }
  if (code === '23505' || message.includes('only open incidents can be acknowledged') || message.includes('status has changed')) {
    return Response.json({ error: { code: 'CONFLICT', message: 'Incident status has changed' } }, { status: 409 });
  }
  return null;
}

export async function POST(
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

    let body: unknown;
    try { body = await request.json(); } catch {
      body = {};
    }
    const parsed = acknowledgeIncidentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: { code: 'INVALID', message: 'Invalid request body', details: parsed.error.flatten() } },
        { status: 400 },
      );
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
        if (!incident) {
          return { error: { code: 'NOT_FOUND' as const, message: 'Incident not found' }, status: 404 as const };
        }
        assertCan(actor, 'incident:manage', {
          organizationId: actor.organizationId,
          clientId: incident.clientId,
        });
        return acknowledgeIncidentForTenant(txSql, {
          incidentId: id,
          organizationId: actor.organizationId,
          actor: actor.userId,
          expectedStatus: parsed.data.expectedStatus,
          correlationId: request.headers.get('x-correlation-id')?.slice(0, 200) ?? crypto.randomUUID(),
        });
      },
    );

    if ('error' in result) {
      return Response.json(
        { error: result.error },
        { status: result.status },
      );
    }

    return Response.json({
      id: result.id,
      status: result.status,
      acknowledgedAt: result.acknowledgedAt,
      acknowledgedBy: result.acknowledgedBy,
      updatedAt: result.updatedAt,
    });
  } catch (err: unknown) {
    return mutationErrorResponse(err) ?? handleServiceError(err);
  }
}
