import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import type postgres from "postgres";

import {
  createIntegration,
  receiveBusinessEvent,
  withIntegrationContext,
  withTenantContext,
} from "@leadops/db";
import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
} from "../../../packages/db/src/test/fixtures.js";
import { processProjection, type ProjectionJob } from "./projector.js";

const logger = pino({ enabled: false });

describe("workflow-run projector", () => {
  let handle: FixtureHandle;
  let organizationId: string;
  let clientId: string;
  let integrationId: string;

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
    const seeded = await seedTenancyFixture(handle);
    organizationId = seeded.orgA.id;
    clientId = seeded.clients.a1.id;
    const created = await withTenantContext(
      handle.app,
      {
        userId: seeded.users.ownerA.id,
        organizationId,
        role: "agency_owner",
      },
      async (tx) =>
        createIntegration(tx as unknown as postgres.Sql, {
          organizationId,
          clientId,
          name: "Projector test",
        }),
    );
    integrationId = created.integration.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function persistEvent(
    webhookId: string,
    eventType: string,
    rawJson: Record<string, unknown>,
  ): Promise<ProjectionJob> {
    const received = await withIntegrationContext(
      handle.app,
      { integrationId, organizationId, clientId },
      async (tx) =>
        receiveBusinessEvent(tx as unknown as postgres.Sql, {
          integrationId,
          organizationId,
          clientId,
          webhookId,
          eventType,
          rawJson,
          bodyHash: `hash-${webhookId}`,
        }),
    );
    return {
      eventId: received.businessEvent.id,
      eventType,
      integrationId,
      organizationId,
      clientId,
    };
  }

  function workflowEvent(
    eventType: "workflow.run.started" | "workflow.run.succeeded" | "workflow.run.failed",
    eventId: string,
  ): Record<string, unknown> {
    return {
      specVersion: "1.0",
      eventId,
      eventType,
      occurredAt: "2026-08-07T00:00:00.000Z",
      source: "n8n",
      organizationId,
      clientId,
      workflow: { id: "workflow-external-1", name: "Lead intake" },
      run: { id: "run-external-1" },
      data:
        eventType === "workflow.run.failed"
          ? { error: { message: "classified projector fixture" } }
          : {},
      metadata: { schemaVersion: "1.0" },
    };
  }

  it("projects a workflow run exactly once under two concurrent deliveries", async () => {
    const job = await persistEvent(
      "project-concurrent",
      "workflow.run.started",
      workflowEvent("workflow.run.started", "00000000-0000-0000-0000-000000000101"),
    );

    await Promise.all([
      processProjection(logger, job, handle.worker),
      processProjection(logger, job, handle.worker),
    ]);

    const [counts] = await handle.owner.unsafe<{
      workflows: string;
      runs: string;
      event_status: string;
    }[]>(
      `SELECT
         (SELECT count(*) FROM workflows WHERE "integrationId" = $1) AS workflows,
         (SELECT count(*) FROM workflow_runs) AS runs,
         (SELECT status FROM business_events WHERE id = $2) AS event_status`,
      [integrationId, job.eventId],
    );
    expect(counts).toEqual({ workflows: "1", runs: "1", event_status: "projected" });
  });

  it("does not regress a terminal run when a delayed started event arrives", async () => {
    const succeeded = await persistEvent(
      "project-succeeded",
      "workflow.run.succeeded",
      workflowEvent("workflow.run.succeeded", "00000000-0000-0000-0000-000000000102"),
    );
    await processProjection(logger, succeeded, handle.worker);

    const delayed = await persistEvent(
      "project-delayed-start",
      "workflow.run.started",
      workflowEvent("workflow.run.started", "00000000-0000-0000-0000-000000000103"),
    );
    await processProjection(logger, delayed, handle.worker);

    const [run] = await handle.owner.unsafe<{ status: string }[]>(
      `SELECT status FROM workflow_runs WHERE "externalRunId" = 'run-external-1'`,
    );
    expect(run?.status).toBe("succeeded");
  });

  it("persists a safe failed status and rethrows malformed known events for retry", async () => {
    const job = await persistEvent("project-malformed", "workflow.run.started", {
      malformed: true,
    });

    await expect(processProjection(logger, job, handle.worker)).rejects.toThrow();
    const [event] = await handle.owner.unsafe<{ status: string; error: string | null }[]>(
      `SELECT status, error_message AS error FROM business_events WHERE id = $1`,
      [job.eventId],
    );
    expect(event?.status).toBe("failed");
    expect(event?.error).toBe("EVENT_SCHEMA_INVALID");
  });

  it("marks an unknown event unhandled without creating a workflow projection", async () => {
    const job = await persistEvent("project-unknown", "vendor.unknown", {
      eventType: "vendor.unknown",
    });
    await processProjection(logger, job, handle.worker);

    const [state] = await handle.owner.unsafe<{ status: string; runs: string }[]>(
      `SELECT
         (SELECT status FROM business_events WHERE id = $1) AS status,
         (SELECT count(*) FROM workflow_runs) AS runs`,
      [job.eventId],
    );
    expect(state).toEqual({ status: "unhandled", runs: "0" });
  });

  it("rejects a job whose tenant binding was substituted", async () => {
    const job = await persistEvent(
      "project-binding",
      "workflow.run.started",
      workflowEvent("workflow.run.started", "00000000-0000-0000-0000-000000000104"),
    );
    const [foreign] = await handle.owner.unsafe<{ id: string }[]>(
      `SELECT id FROM clients WHERE "organizationId" <> $1 LIMIT 1`,
      [organizationId],
    );
    if (!foreign) throw new Error("foreign client fixture missing");

    await expect(
      processProjection(logger, { ...job, clientId: foreign.id }, handle.worker),
    ).rejects.toThrow("Business event not found in integration scope");
    const [event] = await handle.owner.unsafe<{ status: string }[]>(
      `SELECT status FROM business_events WHERE id = $1`,
      [job.eventId],
    );
    expect(event?.status).toBe("received");
  });
});
