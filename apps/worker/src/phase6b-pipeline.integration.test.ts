import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GENERATION_VERSION } from "@leadops/core";
import { createLogger } from "@leadops/observability";

import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
  type TenancyFixture,
} from "../../../packages/db/src/test/fixtures.js";
import { handleIncidentsOpenFromFailure } from "./handlers/incidents-open-from-failure.js";
import { handleReportsGenerateWeekly } from "./handlers/reports-generate-weekly.js";
import { getJob } from "./jobs/registry.js";
import { createJobWrapper, JobError } from "./jobs/wrapper.js";
import { createWeeklyReportScheduler } from "./scheduler.js";

const logger = createLogger({ service: "phase6b-integration", level: "silent" });

interface IntegrationBinding {
  id: string;
  organizationId: string;
  clientId: string;
}

interface IncidentJobPayload {
  schemaVersion: 1;
  organizationId: string;
  clientId: string;
  integrationId: string;
  occurrenceKey: string;
  jobName: string;
  errorCategory: "permanent";
  errorName: string;
  errorMessage: string;
  attempt: number;
  retryLimit: number;
  correlationId: string;
}

interface WeeklyJobPayload {
  schemaVersion: 1;
  organizationId: string;
  clientId: string;
  integrationId: string;
  periodStart: string;
  periodEnd: string;
  correlationId?: string;
}

function workerDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for integration tests");
  const parsed = new URL(value);
  const isTestRole = parsed.username === "leadops_runtime_test";
  parsed.username = isTestRole ? "leadops_worker_test" : "leadops_worker";
  parsed.password = isTestRole ? "leadops_worker_test_dev" : "leadops_worker_dev";
  return parsed.toString();
}

async function waitFor(
  condition: () => Promise<boolean>,
  diagnostics: () => Promise<string>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Phase 6B integration condition timed out: ${await diagnostics()}`);
}

describe("Phase 6B worker pipelines", () => {
  let fixture: FixtureHandle;
  let seeded: TenancyFixture;
  let integration: IntegrationBinding;
  let boss: PgBoss;
  const workerErrors: string[] = [];

  beforeAll(async () => {
    fixture = createFixtureHandle();
    await resetSchema(fixture);
    seeded = await seedTenancyFixture(fixture);

    const rows = await fixture.owner.unsafe<IntegrationBinding[]>(
      `INSERT INTO integrations ("organizationId", "clientId", name, status)
       VALUES ($1, $2, 'Phase 6B integration', 'active')
       RETURNING id, "organizationId", "clientId"`,
      [seeded.orgA.id, seeded.clients.a1.id],
    );
    const row = rows[0];
    if (!row) throw new Error("integration fixture insert returned no row");
    integration = row;

    boss = new PgBoss({ connectionString: workerDatabaseUrl(), schema: "pgboss_test" });
    boss.on("error", (error) => workerErrors.push(error.message));
    await boss.start();
    await boss.createQueue("incidents.open-from-failure");
    await boss.createQueue("reports.generate-weekly");

    await boss.work<IncidentJobPayload>(
      "incidents.open-from-failure",
      { pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) {
          await handleIncidentsOpenFromFailure(fixture.worker, logger, job.data);
        }
      },
    );
    await boss.work<WeeklyJobPayload>(
      "reports.generate-weekly",
      { pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) {
          await handleReportsGenerateWeekly(fixture.worker, logger, job.data);
        }
      },
    );
  }, 30_000);

  afterAll(async () => {
    await boss.stop({ timeout: 5_000 });
    await fixture.close();
  });

  it("routes a terminal wrapped-job failure through pg-boss into one correlated incident", async () => {
    const definition = getJob("events.project");
    if (!definition) throw new Error("events.project job definition is missing");
    const originalHandler = definition.handler;
    definition.handler = () => {
      const error = new Error("upstream rejected the permanent request");
      error.name = "PermanentDeliveryError";
      return Promise.reject(error);
    };

    const wrapper = createJobWrapper({
      logger,
      sql: fixture.worker,
      onIncidentEscalation: async (event) => {
        if (!event.organizationId || !event.clientId || !event.integrationId) {
          throw new Error("incident escalation lost its tenant binding");
        }
        const occurrenceKey = `${event.jobName}:${event.correlationId}`;
        await boss.send("incidents.open-from-failure", {
          schemaVersion: 1,
          organizationId: event.organizationId,
          clientId: event.clientId,
          integrationId: event.integrationId,
          occurrenceKey,
          jobName: event.jobName,
          errorCategory: "permanent",
          errorName: event.errorName,
          errorMessage: event.errorMessage,
          attempt: event.attempt,
          retryLimit: event.retryLimit,
          correlationId: event.correlationId,
        } satisfies IncidentJobPayload);
      },
    });

    try {
      await expect(
        wrapper.execute(
          "events.project",
          {
            schemaVersion: 1,
            eventId: "00000000-0000-4000-8000-000000000601",
            eventType: "workflow.run.failed",
            organizationId: integration.organizationId,
            clientId: integration.clientId,
            integrationId: integration.id,
            correlationId: "phase6b-terminal-failure",
          },
          { jobId: "phase6b-failed-job", attempt: 0 },
        ),
      ).rejects.toMatchObject({ code: "PERMANENT" } satisfies Partial<JobError>);
    } finally {
      definition.handler = originalHandler;
    }

    await waitFor(
      async () => {
        const rows = await fixture.owner.unsafe<{ count: string }[]>(
          `SELECT count(*) AS count FROM incidents
           WHERE "organizationId" = $1 AND "clientId" = $2`,
          [integration.organizationId, integration.clientId],
        );
        return rows[0]?.count === "1";
      },
      async () => {
        const rows = await fixture.owner.unsafe(`SELECT * FROM incidents`);
        return JSON.stringify({ rows, workerErrors });
      },
    );

    const [incident] = await fixture.owner.unsafe<{
      id: string;
      occurrenceCount: number;
    }[]>(
      `SELECT id, "occurrenceCount" FROM incidents`,
    );
    expect(incident).toMatchObject({
      occurrenceCount: 1,
    });
    if (!incident) throw new Error("incident pipeline did not persist an incident");

    const events = await fixture.owner.unsafe<{
      eventType: string;
      correlationId: string;
      occurrenceKey: string;
    }[]>(
      `SELECT event_type AS "eventType", "correlationId", "occurrenceKey"
       FROM incident_events WHERE "incidentId" = $1`,
      [incident.id],
    );
    expect(events).toEqual([
      {
        eventType: "opened",
        correlationId: "phase6b-terminal-failure",
        occurrenceKey: "events.project:phase6b-terminal-failure",
      },
    ]);
  });

  it("discovers a due client, runs the weekly pg-boss handler, and creates one snapshot", async () => {
    const scheduler = createWeeklyReportScheduler({
      logger,
      sql: fixture.worker,
      workerId: "phase6b-integration-worker",
      pollIntervalMs: 60_000,
      batchSize: 10,
      getBoss: () => boss,
    });

    await scheduler.runOnce();
    await waitFor(
      async () => {
        const rows = await fixture.owner.unsafe<{ count: string }[]>(
          `SELECT count(*) AS count FROM report_snapshots
           WHERE "organizationId" = $1 AND "clientId" = $2
             AND "generationVersion" = $3`,
          [integration.organizationId, integration.clientId, GENERATION_VERSION],
        );
        return rows[0]?.count === "1";
      },
      async () => {
        const rows = await fixture.owner.unsafe(`SELECT * FROM report_snapshots`);
        return JSON.stringify({ rows, workerErrors });
      },
    );

    await scheduler.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await scheduler.shutdown();

    const rows = await fixture.owner.unsafe<{
      count: string;
      periodIsWeek: boolean;
      integrationId: string;
    }[]>(
      `SELECT count(*) AS count,
              bool_and("periodEnd" - "periodStart" = interval '7 days') AS "periodIsWeek",
              min("integrationId"::text) AS "integrationId"
       FROM report_snapshots
       WHERE "organizationId" = $1 AND "clientId" = $2
         AND "generationVersion" = $3`,
      [integration.organizationId, integration.clientId, GENERATION_VERSION],
    );
    expect(rows[0]).toEqual({
      count: "1",
      periodIsWeek: true,
      integrationId: integration.id,
    });
    expect(workerErrors).toEqual([]);
  });
});
