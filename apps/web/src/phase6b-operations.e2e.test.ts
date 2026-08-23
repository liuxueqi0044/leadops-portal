import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";

import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createReportSnapshot,
  openOrAggregateIncident,
  withIntegrationContext,
} from "@leadops/db";

import {
  createFixtureHandle,
  createSession,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
  type TenancyFixture,
} from "../../../packages/db/src/test/fixtures.js";

interface Binding {
  id: string;
  organizationId: string;
  clientId: string;
}

const sessions = {
  ownerA: "phase6b-owner-a",
  ownerB: "phase6b-owner-b",
  viewerA: "phase6b-viewer-a",
} as const;

let fixture: FixtureHandle;
let seeded: TenancyFixture;
let incidentAId: string;
let incidentBId: string;
let reportAId: string;
let server: ChildProcess;
let serverOutput = "";
let baseUrl = "";

function sql(value: unknown): postgres.Sql {
  return value as postgres.Sql;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("could not allocate Phase 6B E2E port"));
        return;
      }
      listener.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`web server exited before readiness\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health/live`);
      if (response.ok) return;
    } catch {
      // The server has not opened the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`web server readiness timed out\n${serverOutput}`);
}

async function terminate(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => process.once("exit", () => {
    resolve();
  }));
  process.kill("SIGKILL");
  await exited;
}

function api(pathname: string, token?: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set("cookie", `better-auth.session_token=${token}`);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(init.method ?? "GET")) {
      headers.set("origin", baseUrl);
    }
  }
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

async function createBinding(
  organizationId: string,
  clientId: string,
  name: string,
): Promise<Binding> {
  const rows = await fixture.owner.unsafe<Binding[]>(
    `INSERT INTO integrations ("organizationId", "clientId", name, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING id, "organizationId", "clientId"`,
    [organizationId, clientId, name],
  );
  const row = rows[0];
  if (!row) throw new Error("integration fixture insert returned no row");
  return row;
}

async function createIncident(binding: Binding, key: string): Promise<string> {
  return withIntegrationContext(fixture.worker, {
    organizationId: binding.organizationId,
    clientId: binding.clientId,
    integrationId: binding.id,
  }, async (tx) => {
    const result = await openOrAggregateIncident(sql(tx), {
      organizationId: binding.organizationId,
      clientId: binding.clientId,
      integrationId: binding.id,
      occurrenceKey: key,
      fingerprint: `${binding.organizationId}|${binding.clientId}|e2e|permanent|ProviderError`,
      category: "permanent",
      severity: "high",
      errorSummary: "Provider rejected the operation",
      jobName: "events.project",
      correlationId: `${key}-opened`,
    });
    return result.id;
  });
}

async function createReport(binding: Binding, correlationId: string): Promise<string> {
  return withIntegrationContext(fixture.worker, {
    organizationId: binding.organizationId,
    clientId: binding.clientId,
    integrationId: binding.id,
  }, async (tx) => {
    const result = await createReportSnapshot(sql(tx), {
      organizationId: binding.organizationId,
      clientId: binding.clientId,
      integrationId: binding.id,
      periodStart: "2026-08-03T00:00:00.000Z",
      periodEnd: "2026-08-10T00:00:00.000Z",
      generationVersion: 1,
      metrics: {
        leadsReceived: 3,
        qualificationRate: 2 / 3,
        approvalConversion: 0.5,
        appointments: 1,
        workflowSuccess: 1,
        workflowFailure: 1,
        openIncidents: 1,
        resolvedIncidents: 0,
      },
      correlationId,
    });
    return result.id;
  });
}

beforeAll(async () => {
  fixture = createFixtureHandle();
  await resetSchema(fixture);
  seeded = await seedTenancyFixture(fixture);
  await Promise.all([
    createSession(fixture, {
      userId: seeded.users.ownerA.id,
      token: sessions.ownerA,
      activeOrganizationId: seeded.orgA.id,
    }),
    createSession(fixture, {
      userId: seeded.users.ownerB.id,
      token: sessions.ownerB,
      activeOrganizationId: seeded.orgB.id,
    }),
    createSession(fixture, {
      userId: seeded.users.clientViewerA.id,
      token: sessions.viewerA,
      activeOrganizationId: seeded.orgA.id,
    }),
  ]);

  const [bindingA, bindingB] = await Promise.all([
    createBinding(seeded.orgA.id, seeded.clients.a1.id, "Phase 6B E2E A"),
    createBinding(seeded.orgB.id, seeded.clients.b1.id, "Phase 6B E2E B"),
  ]);
  [incidentAId, incidentBId, reportAId] = await Promise.all([
    createIncident(bindingA, "phase6b-e2e-a"),
    createIncident(bindingB, "phase6b-e2e-b"),
    createReport(bindingA, "phase6b-report-a"),
    createReport(bindingB, "phase6b-report-b"),
  ]).then(([a, b, reportA]) => [a, b, reportA]);

  const workflows = await fixture.owner.unsafe<{ id: string }[]>(
    `INSERT INTO workflows (
       "organizationId", "integrationId", "clientId", "externalId", name, status
     ) VALUES ($1, $2, $3, 'phase6b-e2e-workflow', 'Phase 6B E2E', 'active')
     RETURNING id`,
    [bindingA.organizationId, bindingA.id, bindingA.clientId],
  );
  const workflow = workflows[0];
  if (!workflow) throw new Error("workflow fixture insert returned no row");
  await fixture.owner.unsafe(
    `INSERT INTO workflow_runs (
       "organizationId", "clientId", "workflowId", "externalRunId",
       status, "startedAt", "succeededAt", "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, 'phase6b-e2e-run', 'succeeded',
       '2026-08-05T01:00:00Z', '2026-08-05T01:01:00Z',
       '2026-08-05T01:00:00Z', '2026-08-05T01:01:00Z')`,
    [bindingA.organizationId, bindingA.clientId, workflow.id],
  );
  await fixture.owner.unsafe(
    `INSERT INTO leads (
       "organizationId", "clientId", source, "externalId", "dedupeKey",
       status, score, "receivedAt"
     ) VALUES ($1, $2, 'phase6b-e2e', 'lead-1', 'phase6b-e2e-lead-1',
       'qualified', 80, '2026-08-05T00:00:00Z')`,
    [bindingA.organizationId, bindingA.clientId],
  );

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${String(port)}`;
  const webDir = path.join(process.cwd(), "apps", "web");
  const nextBin = path.join(webDir, "node_modules", "next", "dist", "bin", "next");
  server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: webDir,
    windowsHide: true,
    env: {
      ...process.env,
      BETTER_AUTH_SECRET: "phase-6b-e2e-secret-at-least-32-characters",
      BETTER_AUTH_URL: baseUrl,
      LEADOPS_ENCRYPTION_KEY: "0".repeat(64),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
  server.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
  await waitForServer();
}, 40_000);

afterAll(async () => {
  await terminate(server);
  await fixture.close();
});

describe("Phase 6B operations HTTP API", () => {
  it("requires authentication and returns tenant-scoped incident data with UTC dates", async () => {
    expect((await api(`/api/v1/incidents?clientId=${seeded.clients.a1.id}`)).status).toBe(401);

    const list = await api(`/api/v1/incidents?clientId=${seeded.clients.a1.id}`, sessions.ownerA);
    expect(list.status, await list.clone().text()).toBe(200);
    const body = await list.json() as {
      items: { id: string; firstSeenAt: string; occurrenceCount: number }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: incidentAId, occurrenceCount: 1 });
    expect(body.items[0]?.firstSeenAt).toMatch(/Z$/);

    const detail = await api(`/api/v1/incidents/${incidentAId}`, sessions.ownerA);
    expect(detail.status, await detail.clone().text()).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      id: incidentAId,
      status: "open",
      events: [{ eventType: "opened", correlationId: "phase6b-e2e-a-opened" }],
    });

    const foreign = await api(`/api/v1/incidents/${incidentAId}`, sessions.ownerB);
    expect(foreign.status).toBe(404);
    const hiddenForeign = await api(`/api/v1/incidents/${incidentBId}`, sessions.ownerA);
    expect(hiddenForeign.status).toBe(404);
  });

  it("allows incident reads but denies state changes to a client viewer", async () => {
    const read = await api(`/api/v1/incidents/${incidentAId}`, sessions.viewerA);
    expect(read.status, await read.clone().text()).toBe(200);

    const denied = await api(`/api/v1/incidents/${incidentAId}/acknowledge`, sessions.viewerA, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedStatus: "open" }),
    });
    expect(denied.status).toBe(403);
  });

  it("audits authorized optimistic incident transitions and rejects stale updates", async () => {
    const acknowledge = await api(`/api/v1/incidents/${incidentAId}/acknowledge`, sessions.ownerA, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "phase6b-e2e-ack",
      },
      body: JSON.stringify({ expectedStatus: "open" }),
    });
    expect(acknowledge.status, await acknowledge.clone().text()).toBe(200);
    await expect(acknowledge.json()).resolves.toMatchObject({ status: "acknowledged" });

    const stale = await api(`/api/v1/incidents/${incidentAId}/acknowledge`, sessions.ownerA, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedStatus: "open" }),
    });
    expect(stale.status).toBe(409);

    const resolve = await api(`/api/v1/incidents/${incidentAId}/resolve`, sessions.ownerA, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "phase6b-e2e-resolve",
      },
      body: JSON.stringify({ expectedStatus: "acknowledged" }),
    });
    expect(resolve.status, await resolve.clone().text()).toBe(200);
    await expect(resolve.json()).resolves.toMatchObject({ status: "resolved" });

    const events = await fixture.owner.unsafe<{ eventType: string; correlationId: string }[]>(
      `SELECT event_type AS "eventType", "correlationId"
       FROM incident_events WHERE "incidentId" = $1 ORDER BY "createdAt"`,
      [incidentAId],
    );
    expect(events).toEqual([
      { eventType: "opened", correlationId: "phase6b-e2e-a-opened" },
      { eventType: "acknowledged", correlationId: "phase6b-e2e-ack" },
      { eventType: "resolved", correlationId: "phase6b-e2e-resolve" },
    ]);
  });

  it("serves immutable report snapshots without revealing another organization", async () => {
    const list = await api(`/api/v1/reports?clientId=${seeded.clients.a1.id}`, sessions.ownerA);
    expect(list.status, await list.clone().text()).toBe(200);
    const body = await list.json() as {
      items: { id: string; periodStart: string; generationVersion: number }[];
    };
    expect(body.items).toEqual([
      expect.objectContaining({
        id: reportAId,
        periodStart: "2026-08-03T00:00:00.000Z",
        generationVersion: 1,
      }),
    ]);

    const detail = await api(`/api/v1/reports/${reportAId}`, sessions.ownerA);
    expect(detail.status, await detail.clone().text()).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      id: reportAId,
      metrics: { leadsReceived: 3, workflowSuccess: 1 },
    });
    expect((await api(`/api/v1/reports/${reportAId}`, sessions.ownerB)).status).toBe(404);
  });

  it("serves dashboard and workflow runs and rejects malformed query boundaries", async () => {
    const dashboard = await api(
      `/api/v1/dashboard?clientId=${seeded.clients.a1.id}`,
      sessions.ownerA,
    );
    expect(dashboard.status, await dashboard.clone().text()).toBe(200);
    await expect(dashboard.json()).resolves.toMatchObject({
      leadsReceived: 1,
      qualificationRate: 1,
      workflowSuccess: 1,
      totalLeads: 1,
      totalQualified: 1,
      avgScore: 80,
    });

    const runs = await api(
      `/api/v1/workflow-runs?clientId=${seeded.clients.a1.id}&status=succeeded`,
      sessions.ownerA,
    );
    expect(runs.status, await runs.clone().text()).toBe(200);
    await expect(runs.json()).resolves.toMatchObject({
      items: [{ externalRunId: "phase6b-e2e-run", status: "succeeded" }],
    });

    const invalidRequests = await Promise.all([
      api(`/api/v1/incidents/not-a-uuid`, sessions.ownerA),
      api(`/api/v1/incidents?clientId=${seeded.clients.a1.id}&cursor=bad`, sessions.ownerA),
      api(`/api/v1/reports?clientId=${seeded.clients.a1.id}&dateFrom=2024-01-01T00%3A00%3A00.000Z&dateTo=2026-01-02T00%3A00%3A00.000Z`, sessions.ownerA),
      api(`/api/v1/workflow-runs?clientId=${seeded.clients.a1.id}&status=unknown`, sessions.ownerA),
    ]);
    expect(invalidRequests.map((response) => response.status)).toEqual([400, 400, 400, 400]);
  });
});
