import { getDefaultDatabase, getOrganization, listAccessibleClients } from '@leadops/db';
import { meResponseSchema } from '@leadops/core';
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

    const handle = getDefaultDatabase();
    const userPromise = handle.sql.unsafe<{
      id: string; email: string; name: string; emailVerified: boolean; createdAt: string;
    }[]>(
      `SELECT id, email, name, "emailVerified" AS "emailVerified", "createdAt"
       FROM users WHERE id = $1`,
      [actor.userId],
    );
    const [userRows, orgRow, clients] = await Promise.all([
      userPromise,
      getOrganization(handle.sql, actor, actor.organizationId),
      listAccessibleClients(handle.sql, actor, {
        organizationId: actor.organizationId,
        limit: 100,
      }),
    ]);
    const userRow = userRows[0];

    if (!userRow) {
      return Response.json(
        { error: { code: 'NOT_FOUND', message: 'Not found' } },
        { status: 404 },
      );
    }

    const body = meResponseSchema.parse({
      user: {
        id: userRow.id,
        email: userRow.email,
        name: userRow.name,
        emailVerified: userRow.emailVerified,
        createdAt: userRow.createdAt,
      },
      organization: {
        id: orgRow.id,
        name: orgRow.name,
        slug: orgRow.slug,
        role: actor.role,
      },
      clients: clients.items.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        createdAt: String(c.createdAt),
        updatedAt: String(c.updatedAt),
      })),
    });

    return Response.json(body);
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
