import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import type postgres from 'postgres';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  upsertLeadAndInsertHistory,
  updateLeadStatus,
  withIntegrationContext,
} from '@leadops/db';

import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  setMemberActive,
  type FixtureHandle,
  type TenancyFixture,
} from '../../../packages/db/src/test/fixtures.js';

let fixture: FixtureHandle;
let seeded: TenancyFixture;
let server: ChildProcessWithoutNullStreams;
let baseUrl: string;
let serverOutput = '';
let eventIntegration: { id: string; secret: string };
const sensitiveValues: string[] = [];

const sessions = {
  ownerA: 'api-owner-a',
  ownerB: 'api-owner-b',
  operatorA: 'api-operator-a',
  viewerA: 'api-viewer-a',
} as const;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') {
        listener.close();
        reject(new Error('could not allocate integration test port'));
        return;
      }
      listener.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`web server exited before readiness (${String(server.exitCode)})\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${url}/api/health/live`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`web server readiness timed out\n${serverOutput}`);
}

async function api(pathname: string, token?: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('cookie', `better-auth.session_token=${token}`);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(init.method ?? 'GET')) {
      headers.set('origin', baseUrl);
    }
  }
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

function signRaw(secret: string, webhookId: string, timestamp: number, rawBody: string): string {
  const encodedSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const key = Buffer.from(encodedSecret, 'base64');
  return `v1,${createHmac('sha256', key)
    .update(`${webhookId}.${String(timestamp)}.${rawBody}`)
    .digest('base64')}`;
}

async function signedEvent(
  integration: { id: string; secret: string },
  webhookId: string,
  rawBody: string,
  options: { timestamp?: number; signature?: string } = {},
): Promise<Response> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  return api('/api/v1/events', undefined, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-leadops-integration-id': integration.id,
      'webhook-id': webhookId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': options.signature ?? signRaw(integration.secret, webhookId, timestamp, rawBody),
    },
    body: rawBody,
  });
}

function workflowPayload(
  eventId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    specVersion: '1.0',
    eventId,
    eventType: 'workflow.run.started',
    occurredAt: '2026-08-07T00:00:00.000Z',
    source: 'n8n',
    organizationId: seeded.orgA.id,
    clientId: seeded.clients.a1.id,
    workflow: { id: `workflow-${eventId}`, name: 'Integration workflow' },
    run: { id: `run-${eventId}` },
    data: { safeMarker: 'phase3-body-marker' },
    metadata: { schemaVersion: '1.0', correlationId: `corr-${eventId}` },
    ...overrides,
  };
}

beforeAll(async () => {
  fixture = createFixtureHandle();
  await resetSchema(fixture);
  seeded = await seedTenancyFixture(fixture);
  await fixture.owner.unsafe(
    `INSERT INTO sessions (token, "userId", "expiresAt", active_organization_id)
     VALUES ($1, $2, now() + interval '1 day', $3),
            ($4, $5, now() + interval '1 day', $6),
            ($7, $8, now() + interval '1 day', $3),
            ($9, $10, now() + interval '1 day', $3)`,
    [
      sessions.ownerA, seeded.users.ownerA.id, seeded.orgA.id,
      sessions.ownerB, seeded.users.ownerB.id, seeded.orgB.id,
      sessions.operatorA, seeded.users.operatorA.id,
      sessions.viewerA, seeded.users.clientViewerA.id,
    ],
  );

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${String(port)}`;
  const webDir = path.join(process.cwd(), 'apps', 'web');
  const nextBin = path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  server = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: webDir,
    env: {
      ...process.env,
      BETTER_AUTH_SECRET: 'phase-2-integration-secret-at-least-32-characters',
      BETTER_AUTH_URL: baseUrl,
      LEADOPS_ENCRYPTION_KEY: '0'.repeat(64),
    },
    stdio: 'pipe',
  });
  server.stdout.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
  await waitForServer(baseUrl);

  const integrationResponse = await api('/api/v1/integrations', sessions.ownerA, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: seeded.clients.a1.id, name: 'HTTP event integration' }),
  });
  if (integrationResponse.status !== 201) {
    throw new Error(`integration fixture creation failed: ${String(integrationResponse.status)} ${await integrationResponse.text()}`);
  }
  const integrationBody = await integrationResponse.json() as {
    integration: { id: string };
    secret: string;
  };
  eventIntegration = { id: integrationBody.integration.id, secret: integrationBody.secret };
  sensitiveValues.push(integrationBody.secret);
}, 30_000);

afterAll(async () => {
  if (server.exitCode === null) server.kill();
  await fixture.close();
});

describe('Phase 2 API tenant enforcement', () => {
  it('rejects requests without a session', async () => {
    const response = await api('/api/v1/clients');
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('returns only the active organization clients', async () => {
    const response = await api('/api/v1/clients', sessions.ownerA);
    expect(response.status).toBe(200);
    const body = await response.json() as { items: { id: string }[] };
    expect(body.items.map((client) => client.id).sort()).toEqual(
      [seeded.clients.a1.id, seeded.clients.a2.id].sort(),
    );
    expect(body.items.map((client) => client.id)).not.toContain(seeded.clients.b1.id);
  });

  it('limits an operator to assigned clients', async () => {
    const list = await api('/api/v1/clients', sessions.operatorA);
    expect(list.status).toBe(200);
    const body = await list.json() as { items: { id: string }[] };
    expect(body.items.map((client) => client.id)).toEqual([seeded.clients.a1.id]);

    const inaccessible = await api(`/api/v1/clients/${seeded.clients.a2.id}`, sessions.operatorA);
    expect(inaccessible.status).toBe(403);
  });

  it('does not reveal a foreign organization client by id', async () => {
    const response = await api(`/api/v1/clients/${seeded.clients.b1.id}`, sessions.ownerA);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('denies every client mutation to a client viewer', async () => {
    const create = await api('/api/v1/clients', sessions.viewerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Denied' }),
    });
    expect(create.status).toBe(403);

    const update = await api(`/api/v1/clients/${seeded.clients.a1.id}`, sessions.viewerA, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Denied' }),
    });
    expect(update.status).toBe(403);
  });

  it('creates an owner client in the session organization and writes audit', async () => {
    const response = await api('/api/v1/clients', sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'API Created' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; name: string };
    expect(body.name).toBe('API Created');

    const rows = await fixture.owner.unsafe<{ organizationId: string; action: string }[]>(
      `SELECT c."organizationId", a.action
       FROM clients c
       JOIN audit_logs a ON a."resourceId" = c.id
       WHERE c.id = $1`,
      [body.id],
    );
    expect(rows).toEqual([{ organizationId: seeded.orgA.id, action: 'client.created' }]);
  });

  it('returns the authenticated user, organization and authorized clients', async () => {
    const response = await api('/api/v1/me', sessions.operatorA);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      user: { id: string };
      organization: { id: string; role: string };
      clients: { id: string }[];
    };
    expect(body.user.id).toBe(seeded.users.operatorA.id);
    expect(body.organization).toMatchObject({ id: seeded.orgA.id, role: 'agency_operator' });
    expect(body.clients.map((client) => client.id)).toEqual([seeded.clients.a1.id]);
  });

  it('invalidates an existing session immediately after membership deactivation', async () => {
    await setMemberActive(fixture, {
      organizationId: seeded.orgA.id,
      userId: seeded.users.operatorA.id,
      active: false,
    });
    const response = await api('/api/v1/clients', sessions.operatorA);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
});

describe('Phase 3 signed event API', () => {
  it('rejects a body larger than 1 MB before signature verification', async () => {
    const response = await api('/api/v1/events', undefined, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-leadops-integration-id': eventIntegration.id,
        'webhook-id': 'oversized-event',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,invalid',
      },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID', message: 'Body too large' },
    });
  });

  it('accepts a correct raw-byte signature and persists one event plus outbox', async () => {
    const raw = JSON.stringify(workflowPayload('00000000-0000-0000-0000-000000000201'));
    const response = await signedEvent(eventIntegration, 'http-correct-1', raw);
    expect(response.status, serverOutput.slice(-2000)).toBe(202);
    const body = await response.json() as { eventId: string };

    const [stored] = await fixture.owner.unsafe<{
      status: string;
      raw_json: unknown;
      outbox_count: string;
    }[]>(
      `SELECT e.status, e.raw_json,
              (SELECT count(*) FROM outbox o WHERE o.aggregate_id = e.id::text) AS outbox_count
       FROM business_events e WHERE e.id = $1`,
      [body.eventId],
    );
    expect(stored?.status).toBe('received');
    expect(stored?.raw_json).toEqual(JSON.parse(raw));
    expect(Number(stored?.outbox_count)).toBe(1);
  });

  it('rejects bad, expired, and future signatures with 401', async () => {
    const raw = JSON.stringify(workflowPayload('00000000-0000-0000-0000-000000000202'));
    const bad = await signedEvent(eventIntegration, 'http-bad-signature', raw, {
      signature: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    });
    expect(bad.status).toBe(401);

    const now = Math.floor(Date.now() / 1000);
    const expired = await signedEvent(eventIntegration, 'http-expired', raw, {
      timestamp: now - 301,
    });
    expect(expired.status).toBe(401);
    const future = await signedEvent(eventIntegration, 'http-future', raw, {
      timestamp: now + 600,
    });
    expect(future.status).toBe(401);
  });

  it('verifies bytes before parsing and returns 422 for signed invalid JSON', async () => {
    const response = await signedEvent(eventIntegration, 'http-invalid-json', '{"broken":');
    expect(response.status).toBe(422);
  });

  it('rejects payload tenant substitution', async () => {
    const raw = JSON.stringify(
      workflowPayload('00000000-0000-0000-0000-000000000203', {
        clientId: seeded.clients.a2.id,
      }),
    );
    const response = await signedEvent(eventIntegration, 'http-tenant-mismatch', raw);
    expect(response.status).toBe(400);
  });

  it('returns duplicate 200 for the same body and 409 for the same id with a changed body', async () => {
    const raw = JSON.stringify(workflowPayload('00000000-0000-0000-0000-000000000204'));
    expect((await signedEvent(eventIntegration, 'http-idempotent', raw)).status).toBe(202);
    expect((await signedEvent(eventIntegration, 'http-idempotent', raw)).status).toBe(200);
    const changed = JSON.stringify({ ...JSON.parse(raw) as Record<string, unknown>, source: 'changed-source' });
    expect((await signedEvent(eventIntegration, 'http-idempotent', changed)).status).toBe(409);
  });

  it('collapses 20 concurrent identical requests to one event and one outbox', async () => {
    const raw = JSON.stringify(workflowPayload('00000000-0000-0000-0000-000000000205'));
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => signedEvent(eventIntegration, 'http-concurrent-20', raw)),
    );
    expect(responses.filter((response) => response.status === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(19);

    const [counts] = await fixture.owner.unsafe<{ events: string; outbox: string }[]>(
      `SELECT
         (SELECT count(*) FROM business_events WHERE "integrationId" = $1 AND "webhookId" = $2) AS events,
         (SELECT count(*) FROM outbox WHERE aggregate_id = (
           SELECT id::text FROM business_events WHERE "integrationId" = $1 AND "webhookId" = $2
         )) AS outbox`,
      [eventIntegration.id, 'http-concurrent-20'],
    );
    expect(counts).toEqual({ events: '1', outbox: '1' });
  });

  it('stores an unknown event as unhandled and creates no projection message', async () => {
    const raw = JSON.stringify(
      workflowPayload('00000000-0000-0000-0000-000000000206', {
        eventType: 'vendor.future.event',
      }),
    );
    const response = await signedEvent(eventIntegration, 'http-unknown', raw);
    expect(response.status).toBe(202);
    const body = await response.json() as { eventId: string };
    const [stored] = await fixture.owner.unsafe<{ status: string; outbox_count: string }[]>(
      `SELECT e.status,
              (SELECT count(*) FROM outbox o WHERE o.aggregate_id = e.id::text) AS outbox_count
       FROM business_events e WHERE e.id = $1`,
      [body.eventId],
    );
    expect(stored).toEqual({ status: 'unhandled', outbox_count: '0' });
  });

  it('replays a failed event as a new attempt without mutating its raw payload', async () => {
    const raw = JSON.stringify(workflowPayload('00000000-0000-0000-0000-000000000207'));
    const accepted = await signedEvent(eventIntegration, 'http-replay-source', raw);
    const acceptedBody = await accepted.json() as { eventId: string };
    await fixture.owner.unsafe(
      `UPDATE business_events SET status = 'failed', error_message = 'fixture failure' WHERE id = $1`,
      [acceptedBody.eventId],
    );

    const replay = await api(`/api/v1/events/${acceptedBody.eventId}/replay`, sessions.ownerA, {
      method: 'POST',
    });
    expect(replay.status).toBe(200);
    const [stored] = await fixture.owner.unsafe<{ raw_json: unknown; attempts: string }[]>(
      `SELECT e.raw_json,
              (SELECT count(*) FROM outbox o WHERE o.aggregate_id = e.id::text) AS attempts
       FROM business_events e WHERE e.id = $1`,
      [acceptedBody.eventId],
    );
    expect(stored?.raw_json).toEqual(JSON.parse(raw));
    expect(Number(stored?.attempts)).toBe(2);
  });

  it('supports a rotation grace window and rejects all secrets after revocation', async () => {
    const create = await api('/api/v1/integrations', sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: seeded.clients.a1.id, name: 'Rotation integration' }),
    });
    const created = await create.json() as { integration: { id: string }; secret: string };
    expect(create.status).toBe(201);

    const rotate = await api(`/api/v1/integrations/${created.integration.id}?action=rotate-secret`, sessions.ownerA, {
      method: 'POST',
    });
    const rotated = await rotate.json() as { secret: string };
    expect(rotate.status).toBe(200);
    expect(rotated.secret).not.toBe(created.secret);
    sensitiveValues.push(created.secret, rotated.secret);

    const oldRaw = JSON.stringify(workflowPayload('00000000-0000-0000-0000-000000000208'));
    expect((await signedEvent({ id: created.integration.id, secret: created.secret }, 'rotation-old', oldRaw)).status).toBe(202);
    const newRaw = JSON.stringify(workflowPayload('00000000-0000-0000-0000-000000000209'));
    expect((await signedEvent({ id: created.integration.id, secret: rotated.secret }, 'rotation-new', newRaw)).status).toBe(202);

    const revoke = await api(`/api/v1/integrations/${created.integration.id}?action=revoke`, sessions.ownerA, {
      method: 'POST',
    });
    expect(revoke.status).toBe(200);
    const revokedRaw = JSON.stringify(workflowPayload('00000000-0000-0000-0000-000000000210'));
    expect((await signedEvent({ id: created.integration.id, secret: rotated.secret }, 'rotation-revoked', revokedRaw)).status).toBe(401);
  });

  it('denies integration management to a client viewer and does not log secrets or bodies', async () => {
    const denied = await api('/api/v1/integrations', sessions.viewerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: seeded.clients.a1.id, name: 'Denied integration' }),
    });
    expect(denied.status).toBe(403);
    for (const secret of sensitiveValues) expect(serverOutput).not.toContain(secret);
    expect(serverOutput).not.toContain('phase3-body-marker');
    expect(serverOutput.toLowerCase()).not.toContain('webhook-signature');
  });
});

describe('Phase 4 Lead and dashboard API', () => {
  let qualifiedLeadId = '';

  beforeAll(async () => {
    const context = {
      integrationId: eventIntegration.id,
      organizationId: seeded.orgA.id,
      clientId: seeded.clients.a1.id,
    };

    await withIntegrationContext(fixture.app, context, async (tx) => {
      const sql = tx as unknown as postgres.Sql;
      for (let index = 0; index < 3; index++) {
        const result = await upsertLeadAndInsertHistory(sql, {
          organizationId: seeded.orgA.id,
          clientId: seeded.clients.a1.id,
          source: 'phase4-integration',
          externalId: `phase4-api-${String(index)}`,
          contactName: `Phase 4 Lead ${String(index)}`,
          email: `phase4-${String(index)}@example.com`,
          phone: null,
          company: 'Phase 4',
          message: 'API integration fixture',
          receivedAt: `2026-08-0${String(index + 1)}T10:00:00.000Z`,
        });
        if (index === 0) qualifiedLeadId = result.id;
      }

      const transitioned = await updateLeadStatus(sql, {
        leadId: qualifiedLeadId,
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
        command: 'qualify',
        newStatus: 'qualified',
      });
      expect(transitioned).toBe(true);
    });

    await fixture.owner.unsafe(
      `INSERT INTO leads (
         "organizationId", "clientId", source, "externalId",
         "dedupeKey", "dedupeVersion", status, "contactName", "receivedAt"
       ) VALUES ($1, $2, 'phase4-integration', 'phase4-foreign',
                 '1:ext:phase4-integration:phase4-foreign', 1, 'received',
                 'Foreign Tenant Lead', '2026-08-01T10:00:00.000Z')`,
      [seeded.orgB.id, seeded.clients.b1.id],
    );
  });

  it('returns tenant-scoped list, detail history, and dashboard metrics', async () => {
    const list = await api(
      `/api/v1/clients/${seeded.clients.a1.id}/leads?source=phase4-integration&limit=2`,
      sessions.ownerA,
    );
    expect(list.status, await list.clone().text()).toBe(200);
    const listBody = await list.json() as {
      items: { id: string; contactName: string; receivedAt: string }[];
      nextCursor: string | null;
    };
    expect(listBody.items).toHaveLength(2);
    expect(listBody.items.every((item) => item.contactName !== 'Foreign Tenant Lead')).toBe(true);
    expect(listBody.items.every((item) => item.receivedAt.endsWith('Z'))).toBe(true);
    expect(listBody.nextCursor).not.toBeNull();

    const next = await api(
      `/api/v1/clients/${seeded.clients.a1.id}/leads?source=phase4-integration&limit=2&cursor=${encodeURIComponent(listBody.nextCursor ?? '')}`,
      sessions.ownerA,
    );
    expect(next.status, await next.clone().text()).toBe(200);
    const nextBody = await next.json() as { items: { id: string }[] };
    expect(nextBody.items).toHaveLength(1);

    const detail = await api(
      `/api/v1/clients/${seeded.clients.a1.id}/leads/${qualifiedLeadId}`,
      sessions.ownerA,
    );
    expect(detail.status, await detail.clone().text()).toBe(200);
    const detailBody = await detail.json() as {
      id: string;
      status: string;
      statusHistory: { newStatus: string; createdAt: string }[];
    };
    expect(detailBody.id).toBe(qualifiedLeadId);
    expect(detailBody.status).toBe('qualified');
    expect(detailBody.statusHistory.map((entry) => entry.newStatus)).toEqual([
      'received',
      'qualified',
    ]);
    expect(detailBody.statusHistory.every((entry) => entry.createdAt.endsWith('Z'))).toBe(true);

    const dashboard = await api(
      `/api/v1/clients/${seeded.clients.a1.id}/dashboard?dateFrom=2026-08-01T00%3A00%3A00.000Z&dateTo=2026-08-04T00%3A00%3A00.000Z`,
      sessions.ownerA,
    );
    expect(dashboard.status, await dashboard.clone().text()).toBe(200);
    await expect(dashboard.json()).resolves.toMatchObject({
      totalReceived: 3,
      totalQualified: 1,
      qualificationRate: 1 / 3,
    });
  });

  it('rejects malformed cursors and dashboard date ranges at the HTTP boundary', async () => {
    const cursor = await api(
      `/api/v1/clients/${seeded.clients.a1.id}/leads?cursor=not-a-cursor`,
      sessions.ownerA,
    );
    expect(cursor.status).toBe(400);

    const invalidDate = await api(
      `/api/v1/clients/${seeded.clients.a1.id}/dashboard?dateFrom=not-a-date`,
      sessions.ownerA,
    );
    expect(invalidDate.status).toBe(400);

    const reversed = await api(
      `/api/v1/clients/${seeded.clients.a1.id}/dashboard?dateFrom=2026-08-10T00%3A00%3A00.000Z&dateTo=2026-08-09T00%3A00%3A00.000Z`,
      sessions.ownerA,
    );
    expect(reversed.status).toBe(400);
  });

  it('does not reveal a foreign tenant lead through list or detail APIs', async () => {
    const foreign = await fixture.owner.unsafe<{ id: string }[]>(
      `SELECT id FROM leads WHERE "externalId" = 'phase4-foreign'`,
    );
    const foreignId = foreign[0]?.id;
    if (!foreignId) throw new Error('foreign lead fixture missing');

    const list = await api(
      `/api/v1/clients/${seeded.clients.b1.id}/leads?source=phase4-integration`,
      sessions.ownerA,
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ items: [] });

    const detail = await api(
      `/api/v1/clients/${seeded.clients.b1.id}/leads/${foreignId}`,
      sessions.ownerA,
    );
    expect(detail.status).toBe(404);
  });
});

describe('Phase 5 approval HTTP API', () => {
  function approvalPayload(correlationId: string, generateToken = false): Record<string, unknown> {
    return {
      clientId: seeded.clients.a1.id,
      integrationId: eventIntegration.id,
      correlationId,
      requestVersion: '1',
      snapshot: {
        contactName: 'Phase 5 Contact',
        company: 'Phase 5 Corp',
        score: 92,
        qualificationSummary: 'Qualified and awaiting a human decision',
        suggestedNextAction: 'Create CRM opportunity',
      },
      expiresInSeconds: 3600,
      generateToken,
    };
  }

  it('creates an immutable approval idempotently and returns a one-time public token only once', async () => {
    const payload = approvalPayload('phase5-http-idempotent', true);
    const first = await api('/api/v1/approvals', sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const created = await first.json() as {
      id: string;
      status: string;
      version: number;
      token: string;
      snapshot: Record<string, unknown>;
    };
    expect(created).toMatchObject({ status: 'pending', version: 1 });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.snapshot).toEqual((payload.snapshot as Record<string, unknown>));
    sensitiveValues.push(created.token);

    const replay = await api('/api/v1/approvals', sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(replay.status, await replay.clone().text()).toBe(200);
    const replayed = await replay.json() as { id: string; token?: string };
    expect(replayed.id).toBe(created.id);
    expect(replayed).not.toHaveProperty('token');

    const [counts] = await fixture.owner.unsafe<{ approvals: string; history: string; tokens: string }[]>(
      `SELECT
         (SELECT count(*) FROM approvals WHERE correlation_id = $1) AS approvals,
         (SELECT count(*) FROM approval_history WHERE "approvalId" = $2) AS history,
         (SELECT count(*) FROM approval_tokens WHERE "approvalId" = $2) AS tokens`,
      ['phase5-http-idempotent', created.id],
    );
    expect(counts).toEqual({ approvals: '1', history: '1', tokens: '1' });
  });

  it('lets the bound n8n integration create an approval with a signed raw request', async () => {
    const raw = JSON.stringify(approvalPayload('phase5-signed-integration-create', true));
    const webhookId = 'phase5-approval-requested-1';
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await api('/api/v1/approvals', undefined, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-leadops-integration-id': eventIntegration.id,
        'webhook-id': webhookId,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signRaw(eventIntegration.secret, webhookId, timestamp, raw),
      },
      body: raw,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = await response.json() as { id: string; token: string; status: string };
    expect(body).toMatchObject({ status: 'pending' });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    sensitiveValues.push(body.token);

    const badSignature = await api('/api/v1/approvals', undefined, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-leadops-integration-id': eventIntegration.id,
        'webhook-id': 'phase5-approval-bad-signature',
        'webhook-timestamp': String(timestamp),
        'webhook-signature': 'v1,invalid',
      },
      body: raw,
    });
    expect(badSignature.status).toBe(401);
  });

  it('allows exactly one authenticated decision and creates one completion delivery', async () => {
    const create = await api('/api/v1/approvals', sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(approvalPayload('phase5-http-auth-decision')),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const decideBody = JSON.stringify({
      decision: 'approved',
      reason: 'Budget approved',
      expectedVersion: 1,
    });
    const decided = await api(`/api/v1/approvals/${created.id}/decide`, sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: decideBody,
    });
    expect(decided.status, await decided.clone().text()).toBe(200);
    await expect(decided.json()).resolves.toMatchObject({
      id: created.id,
      status: 'approved',
      version: 2,
    });

    const replay = await api(`/api/v1/approvals/${created.id}/decide`, sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: decideBody,
    });
    expect(replay.status).toBe(409);

    const [counts] = await fixture.owner.unsafe<{ decisions: string; deliveries: string }[]>(
      `SELECT
         (SELECT count(*) FROM approval_history
           WHERE "approvalId" = $1 AND new_status = 'approved') AS decisions,
         (SELECT count(*) FROM approval_deliveries
           WHERE "approvalId" = $1 AND message_type = 'approval.completed') AS deliveries`,
      [created.id],
    );
    expect(counts).toEqual({ decisions: '1', deliveries: '1' });
  });

  it('supports a safe public decision without exposing tenant or secret fields', async () => {
    const create = await api('/api/v1/approvals', sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(approvalPayload('phase5-http-public-decision', true)),
    });
    const created = await create.json() as { id: string; token: string };
    expect(create.status).toBe(201);
    sensitiveValues.push(created.token);

    const lookup = await api(`/api/v1/approvals/public/${created.token}`);
    expect(lookup.status).toBe(200);
    const lookupBody = await lookup.json() as Record<string, unknown>;
    expect(lookupBody).toMatchObject({ tokenStatus: 'valid', status: 'pending' });
    expect(JSON.stringify(lookupBody)).not.toContain(seeded.orgA.id);
    expect(JSON.stringify(lookupBody)).not.toContain(seeded.clients.a1.id);
    expect(JSON.stringify(lookupBody).toLowerCase()).not.toContain('secret');

    const decided = await api(`/api/v1/approvals/public/${created.token}/decide`, undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'rejected', reason: 'Not a fit' }),
    });
    expect(decided.status, await decided.clone().text()).toBe(200);
    await expect(decided.json()).resolves.toMatchObject({ status: 'rejected', version: 2 });

    const replay = await api(`/api/v1/approvals/public/${created.token}/decide`, undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ error: 'TOKEN_ALREADY_USED' });
  });

  it('enforces role and tenant boundaries without revealing foreign approvals', async () => {
    const denied = await api('/api/v1/approvals', sessions.viewerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(approvalPayload('phase5-http-viewer-denied')),
    });
    expect(denied.status).toBe(403);

    const create = await api('/api/v1/approvals', sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(approvalPayload('phase5-http-foreign-hidden')),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const foreign = await api(`/api/v1/approvals/${created.id}/decide`, sessions.ownerB, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(foreign.status).toBe(404);
  });

  it('rejects unsafe callback registration, malformed snapshots, and forged tokens', async () => {
    const unsafeCallback = await api('/api/v1/integrations', sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: seeded.clients.a1.id,
        name: 'Unsafe callback integration',
        callbackUrl: 'http://127.0.0.1:8080/internal',
      }),
    });
    expect(unsafeCallback.status).toBe(400);

    const invalidSnapshot = approvalPayload('phase5-http-invalid-snapshot');
    invalidSnapshot.snapshot = {
      contactName: 'Unsafe snapshot',
      internalPrompt: 'must never be exposed',
    };
    const invalid = await api('/api/v1/approvals', sessions.ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalidSnapshot),
    });
    expect(invalid.status).toBe(400);

    const forged = await api('/api/v1/approvals/public/appr_forged-token-value');
    expect(forged.status).toBe(404);
    expect(serverOutput).not.toContain('appr_forged-token-value');
    for (const sensitive of sensitiveValues) expect(serverOutput).not.toContain(sensitive);
  });
});
