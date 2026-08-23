import type postgres from "postgres";
import { getDefaultDatabase, createOutboxMessage, withTenantContext, writeAudit } from "@leadops/db";
import { assertCan } from "@leadops/core";
import { getActorFromRequest } from "@/lib/server/actor";
import { handleServiceError } from "@/lib/server/errors";

function castTx(tx: unknown): postgres.Sql {
  return tx as postgres.Sql;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<Response> {
  try {
    const { eventId } = await params;
    const actor = await getActorFromRequest(_request);
    if (!actor) {
      return Response.json(
        { error: { code: "UNAUTHENTICATED", message: "Not authenticated" } },
        { status: 401 },
      );
    }

    assertCan(actor, "event:replay", { organizationId: actor.organizationId });

    const handle = getDefaultDatabase();

    const outbox = await withTenantContext(handle.sql, actor, async (tx) => {
      const sql = castTx(tx);

      // Read event within same transaction, scoped to tenant
      const eventRows = await sql`
        SELECT id, "organizationId", "integrationId", "clientId", "eventType", status
        FROM business_events
        WHERE id = ${eventId}::uuid
          AND "organizationId" = ${actor.organizationId}
      `;

      if (eventRows.length === 0) {
        throw Object.assign(new Error("Event not found"), { code: "NOT_FOUND" });
      }

      const event = eventRows[0] as {
        id: string;
        organizationId: string;
        integrationId: string;
        clientId: string;
        eventType: string;
        status: string;
      };
      if (event.organizationId !== actor.organizationId) {
        throw Object.assign(new Error("Event not found"), { code: "NOT_FOUND" });
      }

      if (event.status !== "failed") {
        throw Object.assign(new Error("Only failed events can be replayed"), { code: "INVALID" });
      }

      const outboxRow = await createOutboxMessage(sql, {
        organizationId: event.organizationId,
        integrationId: event.integrationId,
        clientId: event.clientId,
        aggregateType: "business_event",
        aggregateId: event.id,
        messageType: "events.project",
        payload: {
          schemaVersion: 1,
          eventId: event.id,
          eventType: event.eventType,
          organizationId: event.organizationId,
          integrationId: event.integrationId,
          clientId: event.clientId,
          replay: true,
        },
      });

      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "event.replayed",
        resourceType: "business_event",
        resourceId: eventId,
        metadata: { reason: "manual replay" },
      });

      return outboxRow;
    });

    return Response.json({
      replayed: true,
      eventId,
      outboxId: outbox.id,
    });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err) {
      const code = (err as Error & { code: string }).code;
      if (code === "NOT_FOUND") {
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Event not found" } },
          { status: 404 },
        );
      }
      if (code === "INVALID") {
        return Response.json(
          { error: { code: "INVALID", message: err.message } },
          { status: 400 },
        );
      }
    }
    return handleServiceError(err);
  }
}
