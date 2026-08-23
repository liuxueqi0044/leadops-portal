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
        reject(new Error("could not allocate E2E port"));
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
  proc.stdout?.on("data", (chunk: Buffer) => {
    state.output += chunk.toString();
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    state.output += chunk.toString();
  });
  return state;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  diagnostics: () => string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`E2E condition timed out. ${diagnostics()}`);
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

describe("signed event pipeline E2E", () => {
  it("accepts an HTTP event and projects it through outbox and pg-boss", async () => {
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
          name: "Phase 3 E2E integration",
        }),
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
          BETTER_AUTH_SECRET: "phase-3-e2e-secret-at-least-32-characters",
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
          try {
            return (await fetch(`${baseUrl}/api/health/live`)).ok;
          } catch {
            return false;
          }
        },
        () => `Web output: ${webState.output.slice(-1000)}`,
      );
      await waitFor(
        () => workerState.output.includes("pgboss.started"),
        () => `Worker output: ${workerState.output.slice(-1000)}`,
      );

      const webhookId = "phase3-e2e-webhook";
      const rawBody = JSON.stringify({
        specVersion: "1.0",
        eventId: "00000000-0000-0000-0000-000000000401",
        eventType: "workflow.run.started",
        occurredAt: "2026-08-07T00:00:00.000Z",
        source: "n8n",
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
        workflow: { id: "phase3-e2e-workflow", name: "Phase 3 E2E" },
        run: { id: "phase3-e2e-run" },
        data: { marker: "phase3-e2e-payload-marker" },
        metadata: { schemaVersion: "1.0", correlationId: "phase3-e2e" },
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
      expect(response.status).toBe(202);

      await waitFor(
        async () => {
          const [state] = await fixture.owner.unsafe<{
            event_status: string;
            outbox_status: string;
            run_status: string;
          }[]>(
            `SELECT
               (SELECT status FROM business_events WHERE "webhookId" = $1) AS event_status,
               (SELECT status FROM outbox WHERE aggregate_id =
                 (SELECT id::text FROM business_events WHERE "webhookId" = $1)) AS outbox_status,
               (SELECT status FROM workflow_runs WHERE "externalRunId" = 'phase3-e2e-run') AS run_status`,
            [webhookId],
          );
          return state?.event_status === "projected"
            && state.outbox_status === "delivered"
            && state.run_status === "started";
        },
        () => `Web: ${webState.output.slice(-700)} Worker: ${workerState.output.slice(-700)}`,
      );

      const [counts] = await fixture.owner.unsafe<{
        events: string;
        outbox: string;
        workflows: string;
        runs: string;
      }[]>(
        `SELECT
           (SELECT count(*) FROM business_events WHERE "webhookId" = $1) AS events,
           (SELECT count(*) FROM outbox WHERE aggregate_id =
             (SELECT id::text FROM business_events WHERE "webhookId" = $1)) AS outbox,
           (SELECT count(*) FROM workflows WHERE "externalId" = 'phase3-e2e-workflow') AS workflows,
           (SELECT count(*) FROM workflow_runs WHERE "externalRunId" = 'phase3-e2e-run') AS runs`,
        [webhookId],
      );
      expect(counts).toEqual({ events: "1", outbox: "1", workflows: "1", runs: "1" });

      const combinedOutput = `${webState.output}\n${workerState.output}`;
      expect(combinedOutput).not.toContain(integration.secret);
      expect(combinedOutput).not.toContain("phase3-e2e-payload-marker");
    } finally {
      await terminate(worker);
      await terminate(web);
      await fixture.close();
    }
  }, 60_000);
});
