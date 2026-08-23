import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { Logger } from 'pino';
import type PgBoss from 'pg-boss';

import {
  createEmailDelivery,
  createIntegration,
  withTenantContext,
} from '@leadops/db';
import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
} from '../../../packages/db/src/test/fixtures.js';
import { handleEmailsSend, setEmailProvider } from './handlers/emails-send.js';
import { createEmailDeliveryEnqueueScheduler, type SchedulerOptions } from './scheduler.js';

function sql(value: unknown): postgres.Sql {
  return value as postgres.Sql;
}

describe('Phase 6A email pipeline E2E', () => {
  let handle: FixtureHandle;

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('discovers, sends, persists, and idempotently replays one email delivery', async () => {
    const fixture = await seedTenancyFixture(handle);
    const organizationId = fixture.orgA.id;
    const clientId = fixture.clients.a1.id;
    const actor = {
      userId: fixture.users.ownerA.id,
      organizationId,
      role: 'agency_owner' as const,
    };
    const integration = await withTenantContext(handle.app, actor, async (tx) =>
      createIntegration(sql(tx), {
        organizationId,
        clientId,
        name: 'phase6-email-e2e',
      }),
    );
    const integrationId = integration.integration.id;
    const delivery = await withTenantContext(handle.app, actor, async (tx) =>
      createEmailDelivery(sql(tx), {
        organizationId,
        clientId,
        integrationId,
        templateName: 'approval-request',
        toEmail: 'customer@example.com',
        subject: 'Approval required',
        htmlBody: '<p>Approval required</p>',
        textBody: 'Approval required',
        idempotencyKey: 'phase6-email-e2e',
      }),
    );

    const sendJob = vi.fn().mockResolvedValue('queued-job');
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const schedulerOptions: SchedulerOptions = {
      logger,
      sql: handle.worker,
      workerId: 'phase6-email-scheduler',
      pollIntervalMs: 60_000,
      batchSize: 10,
      getBoss: () => ({ send: sendJob } as unknown as PgBoss),
    };
    await createEmailDeliveryEnqueueScheduler(schedulerOptions).runOnce();

    expect(sendJob).toHaveBeenCalledTimes(1);
    const payload = sendJob.mock.calls[0]?.[1] as {
      deliveryId: string;
      organizationId: string;
      clientId: string;
      integrationId: string;
    };
    expect(payload).toEqual({
      schemaVersion: 1,
      deliveryId: delivery.id,
      organizationId,
      clientId,
      integrationId,
    });

    const providerSend = vi.fn().mockResolvedValue({
      ok: true,
      retryable: false,
      providerMessageId: 'provider-message-1',
    });
    setEmailProvider({ send: providerSend });

    await handleEmailsSend(handle.worker, logger, payload, 'phase6-email-worker');
    await handleEmailsSend(handle.worker, logger, payload, 'phase6-email-worker-replay');

    expect(providerSend).toHaveBeenCalledTimes(1);
    const [stored] = await handle.owner.unsafe<{
      status: string;
      attemptCount: number;
      providerMessageId: string | null;
    }[]>(
      `SELECT status, attempt_count AS "attemptCount",
              provider_message_id AS "providerMessageId"
       FROM email_deliveries WHERE id = $1::uuid`,
      [delivery.id],
    );
    expect(stored).toEqual({
      status: 'sent',
      attemptCount: 1,
      providerMessageId: 'provider-message-1',
    });
  });
});
