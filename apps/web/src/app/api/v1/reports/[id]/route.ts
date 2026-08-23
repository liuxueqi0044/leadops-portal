import type postgres from "postgres";
import { getDefaultDatabase, withTenantContext, getReportSnapshotForTenant } from '@leadops/db';
import { assertCan, reportSnapshotDtoSchema } from '@leadops/core';
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
      return Response.json({ error: { code: 'INVALID', message: 'Invalid report id' } }, { status: 400 });
    }

    const handle = getDefaultDatabase();

    const snapshot = await withTenantContext(
      handle.sql,
      {
        userId: actor.userId,
        organizationId: actor.organizationId,
        role: actor.role,
      },
      async (tx) => {
        const txSql = tx as unknown as postgres.Sql;
        return getReportSnapshotForTenant(txSql, {
          organizationId: actor.organizationId,
          snapshotId: id,
        });
      },
    );

    if (!snapshot) {
      return Response.json(
        { error: { code: 'NOT_FOUND', message: 'Report snapshot not found' } },
        { status: 404 },
      );
    }
    assertCan(actor, 'report:read', {
      organizationId: actor.organizationId,
      clientId: snapshot.clientId,
    });

    const body = reportSnapshotDtoSchema.parse({
      id: snapshot.id,
      organizationId: snapshot.organizationId,
      clientId: snapshot.clientId,
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd,
      generationVersion: snapshot.generationVersion,
      metrics: snapshot.metrics,
      correlationId: snapshot.correlationId,
      generatedAt: snapshot.generatedAt,
      createdAt: snapshot.createdAt,
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
