import { createProjectorRegistry, parseEvent } from "@leadops/events";
import type { Event, ProjectorResult, LeadReceivedEvent, LeadQualifiedEvent } from "@leadops/events";
import type postgres from "postgres";
import type { Logger } from "pino";
import {
  getDefaultDatabase,
  markEventFailed,
  markEventProjected,
  markEventUnhandled,
  upsertWorkflow,
  upsertWorkflowRun,
  withIntegrationContext,
} from "@leadops/db";
import { projectLeadReceived, projectLeadQualified } from "./lead-projectors.js";

interface ProjectionBinding {
  integrationId: string;
  organizationId: string;
  clientId: string;
}

export function createWorkflowRunProjector(
  sql: postgres.Sql,
  binding: ProjectionBinding,
) {
  const registry = createProjectorRegistry();

  const projectRun = async (event: Event): Promise<ProjectorResult> => {
    if (
      event.eventType !== "workflow.run.started" &&
      event.eventType !== "workflow.run.succeeded" &&
      event.eventType !== "workflow.run.failed"
    ) {
      return { status: "unhandled" };
    }

    const workflow = await upsertWorkflow(sql, {
      organizationId: binding.organizationId,
      integrationId: binding.integrationId,
      clientId: binding.clientId,
      externalId: event.workflow.id,
      name: event.workflow.name ?? event.workflow.id,
    });

    await upsertWorkflowRun(sql, {
      organizationId: binding.organizationId,
      clientId: binding.clientId,
      workflowId: workflow.id,
      externalRunId: event.run.id,
      status:
        event.eventType === "workflow.run.started"
          ? "started"
          : event.eventType === "workflow.run.succeeded"
            ? "succeeded"
            : "failed",
      startedAt: event.eventType === "workflow.run.started" ? event.occurredAt : undefined,
      succeededAt: event.eventType === "workflow.run.succeeded" ? event.occurredAt : undefined,
      failedAt: event.eventType === "workflow.run.failed" ? event.occurredAt : undefined,
      error: event.eventType === "workflow.run.failed" ? event.data?.error : undefined,
    });

    return { status: "projected" };
  };

  registry.register("workflow.run.started", async (event) => projectRun(event));
  registry.register("workflow.run.succeeded", async (event) => projectRun(event));
  registry.register("workflow.run.failed", async (event) => projectRun(event));

  // Phase 4: Lead projectors
  registry.register("lead.received", async (event) => {
    await projectLeadReceived(sql, event as LeadReceivedEvent, binding);
    return { status: "projected" };
  });

  registry.register("lead.qualified", async (event) => {
    await projectLeadQualified(sql, event as LeadQualifiedEvent, binding);
    return { status: "projected" };
  });

  return registry;
}

export interface ProjectionJob {
  eventId: string;
  eventType: string;
  integrationId: string;
  organizationId: string;
  clientId: string;
}

function classifyProjectionError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "ZodError") return "EVENT_SCHEMA_INVALID";
    if (error.message === "Projection job tenant binding mismatch") {
      return "TENANT_BINDING_MISMATCH";
    }
    if (error.message === "Business event not found in integration scope") {
      return "EVENT_NOT_FOUND";
    }
  }
  return "PROJECTION_FAILED";
}

export async function processProjection(
  logger: Logger,
  job: ProjectionJob,
  pool: postgres.Sql = getDefaultDatabase().sql,
): Promise<void> {
  const binding: ProjectionBinding = {
    integrationId: job.integrationId,
    organizationId: job.organizationId,
    clientId: job.clientId,
  };

  try {
    await withIntegrationContext(pool, binding, async (tx) => {
      const sql = tx as unknown as postgres.Sql;
      // Serialize duplicate projector deliveries without granting runtime roles
      // table UPDATE privileges solely for SELECT ... FOR UPDATE.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${job.eventId}, 0))`;
      const rows = await sql`
        SELECT raw_json AS "rawJson", status, "eventType",
               "integrationId", "organizationId", "clientId"
        FROM business_events
        WHERE id = ${job.eventId}::uuid
      `;

      if (rows.length === 0) {
        throw new Error("Business event not found in integration scope");
      }

      const row = rows[0] as {
        rawJson: unknown;
        status: string;
        eventType: string;
        integrationId: string;
        organizationId: string;
        clientId: string;
      };

      if (
        row.integrationId !== binding.integrationId ||
        row.organizationId !== binding.organizationId ||
        row.clientId !== binding.clientId ||
        row.eventType !== job.eventType
      ) {
        throw new Error("Projection job tenant binding mismatch");
      }

      if (row.status === "projected" || row.status === "unhandled") return;

      const registry = createWorkflowRunProjector(sql, binding);
      const handler = registry.get(row.eventType);
      if (!handler) {
        const updated = await markEventUnhandled(sql, job.eventId, binding.integrationId);
        if (!updated) throw new Error("Unable to mark event unhandled");
        return;
      }

      const event = parseEvent(row.rawJson);
      const result = await handler(event, {
        organizationId: binding.organizationId,
        clientId: binding.clientId,
      });

      if (result.status !== "projected") {
        throw new Error(result.error ?? `Projector returned ${result.status}`);
      }

      const updated = await markEventProjected(sql, job.eventId, binding.integrationId);
      if (!updated) throw new Error("Unable to mark event projected");
    });
  } catch (error) {
    const errorCode = classifyProjectionError(error);
    const databaseCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    logger.error(
      {
        event: "projection.failed",
        eventId: job.eventId,
        errorCode,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "Unknown projection error",
        databaseCode,
      },
      "Projection failed",
    );

    try {
      await withIntegrationContext(pool, binding, async (tx) => {
        await markEventFailed(
          tx as unknown as postgres.Sql,
          job.eventId,
          binding.integrationId,
          errorCode,
        );
      });
    } catch (markError) {
      logger.error(
        {
          event: "projection.failure_status_error",
          eventId: job.eventId,
          error: markError instanceof Error ? markError.message : "Unknown status error",
        },
        "Could not persist projection failure status",
      );
    }

    throw error;
  }
}
