import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { platform } from 'node:os';
import type postgres from 'postgres';

import {
  claimOutboxItems,
  createIntegration,
  createOutboxMessage,
  receiveBusinessEvent,
  withIntegrationContext,
  withTenantContext,
} from '@leadops/db';
import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
} from '../../../packages/db/src/test/fixtures.js';

const workerDir = resolve(process.cwd(), 'apps/worker');
const isLinux = platform() === 'linux';

function workerDatabaseUrl(): string {
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) return 'postgresql://leadops_worker_test:leadops_worker_test_dev@127.0.0.1:54321/unavailable?connect_timeout=1';
  const parsed = new URL(appUrl);
  parsed.username = 'leadops_worker_test';
  parsed.password = 'leadops_worker_test_dev';
  return parsed.toString();
}

function spawnWorker(extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ['dist/index.js'], {
    cwd: workerDir,
    windowsHide: true,
    env: {
      ...process.env,
      WORKER_DATABASE_URL: workerDatabaseUrl(),
      PG_BOSS_SCHEMA: 'pgboss_test',
      NODE_ENV: 'test',
      AI_PROVIDER: 'fake',
      LOG_LEVEL: 'info',
      WORKER_HEARTBEAT_MS: '60000',
      WORKER_SHUTDOWN_TIMEOUT_MS: '3000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collectOutput(proc: ChildProcess): { output: string } {
  const state = { output: '' };
  proc.stdout?.on('data', (chunk: Buffer) => {
    state.output += chunk.toString();
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    state.output += chunk.toString();
  });
  return state;
}

function waitForText(
  state: { output: string },
  pattern: RegExp,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const startTime = Date.now();
    const check = (): void => {
      if (pattern.test(state.output)) {
        resolvePromise(state.output);
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        reject(
          new Error(
            `Timeout waiting for ${pattern.source}. Got: ${state.output.slice(-500)}`,
          ),
        );
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function waitForExit(proc: ChildProcess): Promise<[number | null, string | null]> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve([proc.exitCode, proc.signalCode]);
  }
  return new Promise((resolvePromise) => {
    proc.once('exit', (code, signal) => {
      resolvePromise([code, signal]);
    });
  });
}

async function terminate(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGKILL');
  await waitForExit(proc);
}

async function waitForDatabase(
  query: () => Promise<boolean>,
  state: { output: string },
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await query()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Database condition timed out. Worker output: ${state.output.slice(-1000)}`);
}

describe('worker production entry', () => {
  it('starts the built worker and reports database status', async () => {
    const proc = spawnWorker();
    const state = collectOutput(proc);
    try {
      await waitForText(state, /worker\.startup/);
      await waitForText(state, /"database":"(connected|disconnected)"/);
      await waitForText(state, /pgboss\.started/);
      expect(proc.exitCode).toBeNull();
      expect(proc.signalCode).toBeNull();
    } finally {
      await terminate(proc);
    }
  }, 20_000);

  it('handles SIGTERM gracefully on Linux and terminates on Windows', async () => {
    const proc = spawnWorker();
    const state = collectOutput(proc);
    try {
      await waitForText(state, /"database":"(connected|disconnected)"/);
      proc.kill('SIGTERM');
      const [exitCode, exitSignal] = await waitForExit(proc);

      if (isLinux) {
        expect(state.output).toContain('worker.shutdown');
        expect(state.output).toContain('worker.closed');
        expect(exitCode).toBe(0);
        expect(exitSignal).toBeNull();
      } else {
        expect(exitCode !== null || exitSignal !== null).toBe(true);
      }
    } finally {
      await terminate(proc);
    }
  }, 25_000);

  it('recovers an expired outbox lease and projects through pg-boss exactly once', async () => {
    process.env.LEADOPS_ENCRYPTION_KEY ??= '0'.repeat(64);
    const fixture = createFixtureHandle();
    let proc: ChildProcess | null = null;
    try {
      await resetSchema(fixture);
      await fixture.owner.unsafe('DROP SCHEMA IF EXISTS "pgboss_test" CASCADE');
      const seeded = await seedTenancyFixture(fixture);
      const organizationId = seeded.orgA.id;
      const clientId = seeded.clients.a1.id;
      const actor = {
        userId: seeded.users.ownerA.id,
        organizationId,
        role: 'agency_owner' as const,
      };
      const integration = await withTenantContext(fixture.app, actor, async (tx) =>
        createIntegration(tx as unknown as postgres.Sql, {
          organizationId,
          clientId,
          name: 'Worker crash recovery integration',
        }),
      );

      const persisted = await withIntegrationContext(
        fixture.app,
        { integrationId: integration.integration.id, organizationId, clientId },
        async (tx) => {
          const sql = tx as unknown as postgres.Sql;
          const event = await receiveBusinessEvent(sql, {
            integrationId: integration.integration.id,
            organizationId,
            clientId,
            webhookId: 'worker-crash-recovery',
            eventType: 'workflow.run.started',
            rawJson: {
              specVersion: '1.0',
              eventId: '00000000-0000-0000-0000-000000000301',
              eventType: 'workflow.run.started',
              occurredAt: '2026-08-07T00:00:00.000Z',
              source: 'n8n',
              organizationId,
              clientId,
              workflow: { id: 'worker-recovery-workflow' },
              run: { id: 'worker-recovery-run' },
              data: {},
              metadata: { schemaVersion: '1.0' },
            },
            bodyHash: 'worker-crash-recovery-hash',
          });
          const outbox = await createOutboxMessage(sql, {
            organizationId,
            integrationId: integration.integration.id,
            clientId,
            aggregateType: 'business_event',
            aggregateId: event.businessEvent.id,
            messageType: 'events.project',
            payload: {
              schemaVersion: 1,
              eventId: event.businessEvent.id,
              eventType: 'workflow.run.started',
              integrationId: integration.integration.id,
              organizationId,
              clientId,
            },
          });
          return { eventId: event.businessEvent.id, outboxId: outbox.id };
        },
      );

      const crashedClaim = await claimOutboxItems(fixture.worker, 'crashed-worker', 1);
      expect(crashedClaim.map((item) => item.id)).toEqual([persisted.outboxId]);
      await fixture.owner.unsafe(
        `UPDATE outbox SET "lockedAt" = now() - interval '6 minutes' WHERE id = $1`,
        [persisted.outboxId],
      );

      proc = spawnWorker({
        OUTBOX_POLL_MS: '50',
        OUTBOX_BATCH_SIZE: '5',
        LOG_LEVEL: 'debug',
      });
      const state = collectOutput(proc);
      await waitForText(state, /pgboss\.started/);
      try {
        await waitForDatabase(async () => {
          const [row] = await fixture.owner.unsafe<{ event_status: string; outbox_status: string }[]>(
            `SELECT
               (SELECT status FROM business_events WHERE id = $1) AS event_status,
               (SELECT status FROM outbox WHERE id = $2) AS outbox_status`,
            [persisted.eventId, persisted.outboxId],
          );
          return row?.event_status === 'projected' && row.outbox_status === 'delivered';
        }, state);
      } catch (error) {
        const outboxState = await fixture.owner.unsafe(
          `SELECT status, attempt_count, "lockedBy", "lockedAt", last_error
             FROM outbox WHERE id = $1`,
          [persisted.outboxId],
        );
        const jobState = await fixture.owner.unsafe(
          `SELECT id, name, state, retry_count, start_after, created_on
             FROM pgboss_test.job ORDER BY created_on DESC LIMIT 5`,
        );
        const activity = await fixture.owner.unsafe(
          `SELECT usename, state, wait_event_type, wait_event, left(query, 200) AS query
             FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()`,
        );
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Diagnostics: ${JSON.stringify({ outboxState, jobState, activity })}`,
        );
      }

      const [counts] = await fixture.owner.unsafe<{
        workflows: string;
        runs: string;
        attempts: number;
      }[]>(
        `SELECT
           (SELECT count(*) FROM workflows) AS workflows,
           (SELECT count(*) FROM workflow_runs) AS runs,
           (SELECT attempt_count FROM outbox WHERE id = $1) AS attempts`,
        [persisted.outboxId],
      );
      expect(counts).toEqual({ workflows: '1', runs: '1', attempts: 2 });
    } finally {
      if (proc) await terminate(proc);
      await fixture.close();
    }
  }, 25_000);
});
