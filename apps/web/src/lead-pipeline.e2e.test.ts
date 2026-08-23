import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import net from "node:net";
import path from "node:path";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";

import { createIntegration, withTenantContext } from "@leadops/db";
import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
} from "../../../packages/db/src/test/fixtures.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("could not allocate Phase 4 E2E port"));
        return;
      }
      listener.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function collectOutput(proc: ChildProcess): { output: string } {
  const state = { output: "" };
  proc.stdout?.on("data", (chunk: Buffer) => { state.output += chunk.toString(); });
  proc.stderr?.on("data", (chunk: Buffer) => { state.output += chunk.toString(); });
  return state;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  diagnostics: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Phase 4 E2E condition timed out. ${diagnostics()}`);
}

async function terminate(proc: ChildProcess | null): Promise<void> {
  if (proc === null) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => {
    resolve();
  }));
  proc.kill("SIGKILL");
  await exited;
}

function workerDatabaseUrl(): string {
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) throw new Error("DATABASE_URL is required for E2E");
  const parsed = new URL(appUrl);
  parsed.username = "leadops_worker_test";
  parsed.password = "leadops_worker_test_dev";
  return parsed.toString();
}

function signature(secret: string, webhookId: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return `v1,${createHmac("sha256", key)
    .update(`${webhookId}.${String(timestamp)}.${body}`)
    .digest("base64")}`;
}

describe("Phase 4 lead qualification pipeline E2E", () => {
  it("qualifies a signed HTTP lead through outbox, pg-boss, AI audit, and query APIs", async () => {
    process.env.LEADOPS_ENCRYPTION_KEY = "0".repeat(64);
    const fixture = createFixtureHandle();
    let web: ChildProcess | null = null;
    let worker: ChildProcess | null = null;

    try {
      await resetSchema(fixture);
      const seeded = await seedTenancyFixture(fixture);
      const actor = {
        userId: seeded.users.ownerA.id,
        organizationId: seeded.orgA.id,
        role: "agency_owner" as const,
      };
      const integration = await withTenantContext(fixture.app, actor, async (tx) =>
        createIntegration(tx as unknown as postgres.Sql, {
          organizationId: seeded.orgA.id,
          clientId: seeded.clients.a1.id,
          name: "Phase 4 lead E2E integration",
        }),
      );
      const sessionToken = "phase4-e2e-owner-session";
      await fixture.owner.unsafe(
        `INSERT INTO sessions (token, "userId", "expiresAt", active_organization_id)
         VALUES ($1, $2, now() + interval '1 day', $3)`,
        [sessionToken, seeded.users.ownerA.id, seeded.orgA.id],
      );

      const port = await freePort();
      const baseUrl = `http://127.0.0.1:${String(port)}`;
      const webDir = path.join(process.cwd(), "apps", "web");
      const nextBin = path.join(webDir, "node_modules", "next", "dist", "bin", "next");
      web = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
        cwd: webDir,
        windowsHide: true,
        env: {
          ...process.env,
          BETTER_AUTH_SECRET: "phase-4-e2e-secret-at-least-32-characters",
          BETTER_AUTH_URL: baseUrl,
          LEADOPS_ENCRYPTION_KEY: "0".repeat(64),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const webState = collectOutput(web);

      const workerDir = path.join(process.cwd(), "apps", "worker");
      worker = spawn(process.execPath, ["dist/index.js"], {
        cwd: workerDir,
        windowsHide: true,
        env: {
          ...process.env,
          WORKER_DATABASE_URL: workerDatabaseUrl(),
          PG_BOSS_SCHEMA: "pgboss_test",
          NODE_ENV: "test",
          LEADOPS_ENCRYPTION_KEY: "0".repeat(64),
          AI_PROVIDER: "fake",
          OUTBOX_POLL_MS: "50",
          WORKER_HEARTBEAT_MS: "60000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const workerState = collectOutput(worker);

      await waitFor(
        async () => {
          try { return (await fetch(`${baseUrl}/api/health/live`)).ok; } catch { return false; }
        },
        () => `Web output: ${webState.output.slice(-1200)}`,
      );
      await waitFor(
        () => workerState.output.includes("pgboss.started"),
        () => `Worker output: ${workerState.output.slice(-1200)}`,
      );

      const webhookId = "phase4-lead-e2e-webhook";
      // This deterministic fake-provider fixture hashes to score=100, so the
      // E2E can assert the exact qualified terminal result.
      const sensitiveMarker = "phase4-sensitive-form-marker-0";
      const rawBody = JSON.stringify({
        specVersion: "1.0",
        eventId: "00000000-0000-4000-8000-000000000411",
        eventType: "lead.received",
        occurredAt: "2026-08-09T00:00:00.000Z",
        source: "website",
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
        data: {
          lead: {
            id: "phase4-external-lead-1",
            name: "Phase 4 E2E Lead",
            email: "phase4-e2e@example.com",
            company: "LeadOps Test",
            message: sensitiveMarker,
          },
        },
        metadata: { schemaVersion: "1.0", correlationId: "phase4-e2e-correlation" },
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const response = await fetch(`${baseUrl}/api/v1/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-leadops-integration-id": integration.integration.id,
          "webhook-id": webhookId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signature(integration.secret, webhookId, timestamp, rawBody),
        },
        body: rawBody,
      });
      expect(response.status, await response.clone().text()).toBe(202);

      await waitFor(
        async () => {
          const [state] = await fixture.owner.unsafe<{
            event_status: string;
            project_outbox_status: string;
            lead_status: string;
            qualification_outbox_status: string;
            ai_runs: string;
            ai_run_status: string;
            history: string;
          }[]>(
            `SELECT
               (SELECT status FROM business_events WHERE "webhookId" = $1) AS event_status,
               (SELECT status FROM outbox WHERE message_type = 'events.project' AND aggregate_id =
                 (SELECT id::text FROM business_events WHERE "webhookId" = $1)) AS project_outbox_status,
               (SELECT status FROM leads WHERE "externalId" = 'phase4-external-lead-1') AS lead_status,
               (SELECT status FROM outbox WHERE message_type = 'leads.qualify' AND aggregate_id =
                 (SELECT id::text FROM leads WHERE "externalId" = 'phase4-external-lead-1')) AS qualification_outbox_status,
               (SELECT count(*) FROM ai_runs WHERE "leadId" =
                 (SELECT id FROM leads WHERE "externalId" = 'phase4-external-lead-1')) AS ai_runs,
               (SELECT status FROM ai_runs WHERE "leadId" =
                 (SELECT id FROM leads WHERE "externalId" = 'phase4-external-lead-1')) AS ai_run_status,
               (SELECT count(*) FROM lead_status_history WHERE "leadId" =
                 (SELECT id FROM leads WHERE "externalId" = 'phase4-external-lead-1')) AS history`,
            [webhookId],
          );
          return state?.event_status === "projected"
            && state.project_outbox_status === "delivered"
            && state.lead_status === "qualified"
            && state.qualification_outbox_status === "delivered"
            && state.ai_runs === "1"
            && state.ai_run_status === "completed"
            && state.history === "2";
        },
        () => `Web: ${webState.output.slice(-900)} Worker: ${workerState.output.slice(-1400)}`,
      );

      const [counts] = await fixture.owner.unsafe<{
        leads: string;
        ai_runs: string;
        history: string;
        qualification_jobs: string;
      }[]>(
        `SELECT
           (SELECT count(*) FROM leads WHERE "externalId" = 'phase4-external-lead-1') AS leads,
           (SELECT count(*) FROM ai_runs WHERE "leadId" =
             (SELECT id FROM leads WHERE "externalId" = 'phase4-external-lead-1')) AS ai_runs,
           (SELECT count(*) FROM lead_status_history WHERE "leadId" =
             (SELECT id FROM leads WHERE "externalId" = 'phase4-external-lead-1')) AS history,
           (SELECT count(*) FROM outbox WHERE message_type = 'leads.qualify' AND aggregate_id =
             (SELECT id::text FROM leads WHERE "externalId" = 'phase4-external-lead-1')) AS qualification_jobs`,
      );
      expect(counts).toEqual({ leads: "1", ai_runs: "1", history: "2", qualification_jobs: "1" });

      const cookie = { cookie: `better-auth.session_token=${sessionToken}` };
      const list = await fetch(
        `${baseUrl}/api/v1/clients/${seeded.clients.a1.id}/leads?source=website`,
        { headers: cookie },
      );
      expect(list.status, await list.clone().text()).toBe(200);
      const listBody = await list.json() as { items: { externalId: string; status: string }[] };
      expect(listBody.items).toHaveLength(1);
      expect(listBody.items[0]?.externalId).toBe("phase4-external-lead-1");
      expect(listBody.items[0]?.status).toBe("qualified");

      const dashboard = await fetch(
        `${baseUrl}/api/v1/clients/${seeded.clients.a1.id}/dashboard`,
        { headers: cookie },
      );
      expect(dashboard.status, await dashboard.clone().text()).toBe(200);
      const dashboardBody = await dashboard.json() as { totalReceived: number };
      expect(dashboardBody.totalReceived).toBe(1);

      const combinedOutput = `${webState.output}\n${workerState.output}`;
      expect(combinedOutput).not.toContain(integration.secret);
      expect(combinedOutput).not.toContain(sensitiveMarker);
    } finally {
      await terminate(worker);
      await terminate(web);
      await fixture.close();
    }
  }, 60_000);
});
