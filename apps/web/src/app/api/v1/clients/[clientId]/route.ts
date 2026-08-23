import { getDefaultDatabase, getClient, updateClient } from '@leadops/db';
import {
  clientSummaryDtoSchema,
  updateClientRequestSchema,
} from '@leadops/core';
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

    const handle = getDefaultDatabase();
    const client = await getClient(handle.sql, actor, {
      organizationId: actor.organizationId,
      clientId,
    });

    const body = clientSummaryDtoSchema.parse({
      id: client.id,
      name: client.name,
      status: client.status,
      createdAt: String(client.createdAt),
      updatedAt: String(client.updatedAt),
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}

export async function PATCH(
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
    const raw: unknown = await request.json();
    const input = updateClientRequestSchema.parse(raw);

    const handle = getDefaultDatabase();
    const client = await updateClient(handle.sql, actor, {
      organizationId: actor.organizationId,
      clientId,
      name: input.name,
      status: input.status,
    });

    const body = clientSummaryDtoSchema.parse({
      id: client.id,
      name: client.name,
      status: client.status,
      createdAt: String(client.createdAt),
      updatedAt: String(client.updatedAt),
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
