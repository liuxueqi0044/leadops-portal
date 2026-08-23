import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type postgres from 'postgres';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '@leadops/events';
import {
  createApproval,
  createIntegration,
  decideApproval,
  withTenantContext,
} from '@leadops/db';

import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
  type TenancyFixture,
} from '../../../packages/db/src/test/fixtures.js';
import { processApprovalDeliveries } from './approval-callback.js';

interface ReceivedCallback {
  body: string;
  headers: IncomingHttpHeaders;
}

function sql(value: unknown): postgres.Sql {
  return value as postgres.Sql;
}

describe('Phase 5 approval delivery integration', () => {
  let fixture: FixtureHandle;
  let seeded: TenancyFixture;
  let callbackUrl: string;
  let responseStatus = 204;
  const received: ReceivedCallback[] = [];

  const callbackServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: request.headers,
      });
      response.writeHead(responseStatus).end();
    });
  });

  beforeAll(async () => {
    process.env.LEADOPS_ENCRYPTION_KEY ??= '0'.repeat(64);
    fixture = createFixtureHandle();
    await resetSchema(fixture);
    seeded = await seedTenancyFixture(fixture);
    await new Promise<void>((resolve, reject) => {
      callbackServer.once('error', reject);
      callbackServer.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = callbackServer.address() as AddressInfo;
    callbackUrl = `http://callback.localhost:${String(address.port)}/approval-completed`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      callbackServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await fixture.close();
  });

  async function arrangeDecision(correlationId: string): Promise<{
    approvalId: string;
    secret: string;
    deliveryId: string;
  }> {
    const actor = {
      userId: seeded.users.ownerA.id,
      organizationId: seeded.orgA.id,
      role: 'agency_owner' as const,
    };
    const integration = await withTenantContext(fixture.app, actor, (tx) =>
      createIntegration(sql(tx), {
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
        name: `Callback ${correlationId}`,
        callbackUrl,
      }),
    );
    const approval = await withTenantContext(fixture.app, actor, (tx) =>
      createApproval(sql(tx), {
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
        integrationId: integration.integration.id,
        correlationId,
        snapshot: {
          contactName: 'Callback Contact',
          company: 'Callback Corp',
          score: 91,
          qualificationSummary: 'High score lead',
        },
        requestedBy: actor.userId,
      }),
    );
    const decision = await withTenantContext(fixture.app, actor, (tx) =>
      decideApproval(sql(tx), {
        approvalId: approval.id,
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
        decision: 'approved',
        decidedBy: actor.userId,
        expectedVersion: 1,
      }),
    );
    if (!decision.deliveryId) throw new Error('decision delivery was not created');
    return {
      approvalId: approval.id,
      secret: integration.secret,
      deliveryId: decision.deliveryId,
    };
  }

  it('claims, signs, DNS-binds, posts, and acknowledges a completed approval', async () => {
    const arranged = await arrangeDecision('delivery-success');
    responseStatus = 204;
    const offset = received.length;

    await expect(processApprovalDeliveries(fixture.worker, 'delivery-worker-1', 10, {
      allowLocalhost: true,
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    })).resolves.toBe(1);

    expect(received).toHaveLength(offset + 1);
    const callback = received[offset];
    if (!callback) throw new Error('callback was not received');
    const payload = JSON.parse(callback.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      eventType: 'approval.completed',
      approvalId: arranged.approvalId,
      decision: 'approved',
      status: 'approved',
      version: 2,
    });

    const webhookId = String(callback.headers['webhook-id']);
    expect(callback.headers.host).toMatch(/^callback\.localhost:/);
    expect(callback.headers['x-leadops-idempotency-key']).toBe(webhookId);
    expect(verifyWebhookSignature(Buffer.from(callback.body), {
      'webhook-id': webhookId,
      'webhook-timestamp': String(callback.headers['webhook-timestamp']),
      'webhook-signature': String(callback.headers['webhook-signature']),
    }, [arranged.secret])).toEqual({ valid: true });

    const [stored] = await fixture.owner.unsafe<{
      status: string;
      attempt_count: number;
      lockedBy: string | null;
    }[]>(
      `SELECT status, attempt_count, "lockedBy"
       FROM approval_deliveries WHERE id = $1`,
      [arranged.deliveryId],
    );
    expect(stored).toEqual({ status: 'delivered', attempt_count: 1, lockedBy: null });
  });

  it('retries a transient failure without duplicating decision history', async () => {
    const arranged = await arrangeDecision('delivery-retry');
    responseStatus = 503;

    await expect(processApprovalDeliveries(fixture.worker, 'delivery-worker-2', 10, {
      allowLocalhost: true,
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    })).resolves.toBe(1);

    let [delivery] = await fixture.owner.unsafe<{
      status: string;
      attempt_count: number;
      nextAttemptAt: Date;
    }[]>(
      `SELECT status, attempt_count, "nextAttemptAt"
       FROM approval_deliveries WHERE id = $1`,
      [arranged.deliveryId],
    );
    expect(delivery?.status).toBe('pending');
    expect(delivery?.attempt_count).toBe(1);

    await fixture.owner.unsafe(
      `UPDATE approval_deliveries SET "nextAttemptAt" = now() WHERE id = $1`,
      [arranged.deliveryId],
    );
    responseStatus = 204;
    await expect(processApprovalDeliveries(fixture.worker, 'delivery-worker-3', 10, {
      allowLocalhost: true,
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    })).resolves.toBe(1);

    [delivery] = await fixture.owner.unsafe(
      `SELECT status, attempt_count, "nextAttemptAt"
       FROM approval_deliveries WHERE id = $1`,
      [arranged.deliveryId],
    );
    const [counts] = await fixture.owner.unsafe<{ decision_history: string; deliveries: string }[]>(
      `SELECT
         (SELECT count(*) FROM approval_history
           WHERE "approvalId" = $1 AND new_status = 'approved') AS decision_history,
         (SELECT count(*) FROM approval_deliveries
           WHERE "approvalId" = $1) AS deliveries`,
      [arranged.approvalId],
    );
    expect(delivery?.status).toBe('delivered');
    expect(delivery?.attempt_count).toBe(2);
    expect(counts).toEqual({ decision_history: '1', deliveries: '1' });
  });
});
