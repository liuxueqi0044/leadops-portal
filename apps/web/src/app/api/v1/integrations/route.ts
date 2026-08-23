import type postgres from "postgres";
import { getDefaultDatabase, createIntegration, invalid, listIntegrations, withTenantContext, writeAudit } from "@leadops/db";
import { assertCan, resolveCallbackUrl, UnsafeCallbackUrlError } from '@leadops/core';
import { getActorFromRequest } from "@/lib/server/actor";
import { handleServiceError } from "@/lib/server/errors";
import { z } from "zod";

const createIntegrationSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(200),
  callbackUrl: z.string().url().optional(),
});

function castTx(tx: unknown): postgres.Sql {
  return tx as postgres.Sql;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await getActorFromRequest(request);
    if (!actor) {
      return Response.json(
        { error: { code: "UNAUTHENTICATED", message: "Not authenticated" } },
        { status: 401 },
      );
    }

    assertCan(actor, "integration:list", { organizationId: actor.organizationId });

    const handle = getDefaultDatabase();
    const integrations = await withTenantContext(handle.sql, actor, async (tx) => {
      return listIntegrations(castTx(tx), actor.organizationId);
    });

    return Response.json({ items: integrations });
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await getActorFromRequest(request);
    if (!actor) {
      return Response.json(
        { error: { code: "UNAUTHENTICATED", message: "Not authenticated" } },
        { status: 401 },
      );
    }

    const body = createIntegrationSchema.parse(await request.json());

    if (body.callbackUrl) {
      try {
        await resolveCallbackUrl(body.callbackUrl, {
          allowLocalhost:
            process.env.NODE_ENV === 'test' && process.env.CALLBACK_ALLOW_LOCALHOST === 'true',
        });
      } catch (error) {
        if (error instanceof UnsafeCallbackUrlError) throw invalid(error.message);
        throw error;
      }
    }

    assertCan(actor, "integration:create", {
      organizationId: actor.organizationId,
      clientId: body.clientId,
    });

    const handle = getDefaultDatabase();
    const result = await withTenantContext(handle.sql, actor, async (tx) => {
      const sql = castTx(tx);
      const r = await createIntegration(sql, {
        organizationId: actor.organizationId,
        clientId: body.clientId,
        name: body.name,
        callbackUrl: body.callbackUrl,
      });

      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "integration.created",
        resourceType: "integration",
        resourceId: r.integration.id,
        clientId: body.clientId,
        metadata: { name: body.name },
      });

      return r;
    });

    return Response.json(
      {
        integration: {
          id: result.integration.id,
          name: result.integration.name,
          status: result.integration.status,
          clientId: result.integration.clientId,
          createdAt: result.integration.createdAt,
          callbackUrl: result.integration.callbackUrl,
        },
        secret: result.secret,
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
