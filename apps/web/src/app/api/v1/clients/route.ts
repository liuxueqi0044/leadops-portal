import { getDefaultDatabase, createClient, listAccessibleClients } from '@leadops/db';
import {
  clientsListResponseSchema,
  clientSummaryDtoSchema,
  createClientRequestSchema,
  clientsListQuerySchema,
} from '@leadops/core';
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
    const query = clientsListQuerySchema.parse({
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });

    const handle = getDefaultDatabase();
    const result = await listAccessibleClients(handle.sql, actor, {
      organizationId: actor.organizationId,
      limit: query.limit ?? 50,
      cursor: query.cursor ?? null,
    });

    const body = clientsListResponseSchema.parse({
      items: result.items.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        createdAt: String(c.createdAt),
        updatedAt: String(c.updatedAt),
      })),
      nextCursor: result.nextCursor,
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await getActorFromRequest(request);
    if (!actor) {
      return Response.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } },
        { status: 401 },
      );
    }

    const raw: unknown = await request.json();
    const input = createClientRequestSchema.parse(raw);

    const handle = getDefaultDatabase();
    const client = await createClient(handle.sql, actor, {
      organizationId: actor.organizationId,
      name: input.name,
    });

    const body = clientSummaryDtoSchema.parse({
      id: client.id,
      name: client.name,
      status: client.status,
      createdAt: String(client.createdAt),
      updatedAt: String(client.updatedAt),
    });

    return Response.json(body, { status: 201 });
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
