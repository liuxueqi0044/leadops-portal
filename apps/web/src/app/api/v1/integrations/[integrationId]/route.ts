import type postgres from "postgres";
import { getDefaultDatabase, getIntegration, invalid, rotateIntegrationSecret, revokeIntegration, configureIntegrationCallback, withTenantContext, writeAudit } from "@leadops/db";
import { assertCan, resolveCallbackUrl, UnsafeCallbackUrlError } from "@leadops/core";
import { getActorFromRequest } from "@/lib/server/actor";
import { handleServiceError } from "@/lib/server/errors";
import { z } from 'zod';

function castTx(tx: unknown): postgres.Sql {
  return tx as postgres.Sql;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ integrationId: string }> },
): Promise<Response> {
  try {
    const { integrationId } = await params;
    const actor = await getActorFromRequest(_request);
    if (!actor) {
      return Response.json(
        { error: { code: "UNAUTHENTICATED", message: "Not authenticated" } },
        { status: 401 },
      );
    }

    assertCan(actor, "integration:list", { organizationId: actor.organizationId });

    const handle = getDefaultDatabase();
    const integration = await withTenantContext(handle.sql, actor, async (tx) => {
      return getIntegration(castTx(tx), {
        organizationId: actor.organizationId,
        integrationId,
      });
    });

    if (!integration) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Integration not found" } },
        { status: 404 },
      );
    }

    return Response.json({ integration });
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ integrationId: string }> },
): Promise<Response> {
  try {
    const { integrationId } = await params;
    const actor = await getActorFromRequest(request);
    if (!actor) {
      return Response.json(
        { error: { code: "UNAUTHENTICATED", message: "Not authenticated" } },
        { status: 401 },
      );
    }

    const handle = getDefaultDatabase();
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    if (action === "rotate-secret") {
      assertCan(actor, "integration:rotate_secret", { organizationId: actor.organizationId });

      const result = await withTenantContext(handle.sql, actor, async (tx) => {
        const sql = castTx(tx);
        const r = await rotateIntegrationSecret(sql, {
          organizationId: actor.organizationId,
          integrationId,
        });

        await writeAudit(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "integration.secret_rotated",
          resourceType: "integration",
          resourceId: integrationId,
          metadata: { name: r.integration.name },
        });

        return r;
      });

      return Response.json({
        integration: {
          id: result.integration.id,
          name: result.integration.name,
          status: result.integration.status,
        },
        secret: result.newSecret,
      });
    }

    if (action === "revoke") {
      assertCan(actor, "integration:revoke", { organizationId: actor.organizationId });

      const integration = await withTenantContext(handle.sql, actor, async (tx) => {
        const sql = castTx(tx);
        const r = await revokeIntegration(sql, {
          organizationId: actor.organizationId,
          integrationId,
        });

        await writeAudit(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "integration.revoked",
          resourceType: "integration",
          resourceId: integrationId,
          metadata: { name: r.name },
        });

        return r;
      });

      return Response.json({ integration });
    }

    if (action === 'configure-callback') {
      assertCan(actor, 'integration:create', {
        organizationId: actor.organizationId,
      });
      const body = z.object({ callbackUrl: z.string().url() }).parse(await request.json());
      try {
        await resolveCallbackUrl(body.callbackUrl, {
          allowLocalhost:
            process.env.NODE_ENV === 'test' && process.env.CALLBACK_ALLOW_LOCALHOST === 'true',
        });
      } catch (error) {
        if (error instanceof UnsafeCallbackUrlError) throw invalid(error.message);
        throw error;
      }

      const integration = await withTenantContext(handle.sql, actor, async (tx) => {
        const updated = await configureIntegrationCallback(castTx(tx), {
          organizationId: actor.organizationId,
          integrationId,
          callbackUrl: body.callbackUrl,
        });
        await writeAudit(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: 'integration.callback_configured',
          resourceType: 'integration',
          resourceId: integrationId,
          clientId: updated.clientId,
          metadata: { callbackConfigured: true },
        });
        return updated;
      });

      return Response.json({ integration });
    }

    return Response.json(
      { error: { code: "INVALID", message: "Unknown action" } },
      { status: 400 },
    );
  } catch (err: unknown) {
    return handleServiceError(err);
  }
}
