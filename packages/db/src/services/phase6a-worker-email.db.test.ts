import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
} from '../test/fixtures.js';
import { withIntegrationContext, withTenantContext } from '../tenancy/context.js';
import { createApproval, claimApprovalDeliveryExact, expireApprovalsForTenant } from './approvals.js';
import { createEmailDelivery } from './email.js';
import { createIntegration } from './integrations.js';

function sql(value: unknown): postgres.Sql {
  return value as postgres.Sql;
}

describe('Phase 6A worker and email database contract', () => {
  let handle: FixtureHandle;
  let organizationId: string;
  let clientId: string;
  let primaryIntegrationId: string;
  let secondaryIntegrationId: string;
  let actor: { userId: string; organizationId: string; role: 'agency_owner' };

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
    const fixture = await seedTenancyFixture(handle);
    organizationId = fixture.orgA.id;
    clientId = fixture.clients.a1.id;
    actor = {
      userId: fixture.users.ownerA.id,
      organizationId,
      role: 'agency_owner',
    };

    const [primary, secondary] = await withTenantContext(handle.app, actor, async (tx) =>
      Promise.all([
        createIntegration(sql(tx), {
          organizationId,
          clientId,
          name: 'phase6-primary',
          callbackUrl: 'https://example.com/approval-result',
        }),
        createIntegration(sql(tx), {
          organizationId,
          clientId,
          name: 'phase6-secondary',
          callbackUrl: 'https://example.com/approval-result-2',
        }),
      ]),
    );
    primaryIntegrationId = primary.integration.id;
    secondaryIntegrationId = secondary.integration.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function createPendingApproval(integrationId: string, correlationId: string) {
    return withTenantContext(handle.app, actor, async (tx) =>
      createApproval(sql(tx), {
        organizationId,
        clientId,
        integrationId,
        correlationId,
        requestedBy: actor.userId,
        expiresInSeconds: -1,
        snapshot: { contactName: 'Phase 6A', company: 'LeadOps' },
      }),
    );
  }

  it('discovers due work through functions while direct worker table reads remain revoked', async () => {
    await createPendingApproval(primaryIntegrationId, 'phase6-expire-discovery');
    const email = await withTenantContext(handle.app, actor, async (tx) =>
      createEmailDelivery(sql(tx), {
        organizationId,
        clientId,
        integrationId: primaryIntegrationId,
        templateName: 'approval-request',
        toEmail: 'customer@example.com',
        subject: 'Approval required',
        htmlBody: '<p>Approval required</p>',
        textBody: 'Approval required',
        idempotencyKey: 'phase6-email-discovery',
      }),
    );

    const [privileges] = await handle.owner.unsafe<{
      approvals: boolean;
      approvalDeliveries: boolean;
      emailDeliveries: boolean;
    }[]>(
      `SELECT
         has_table_privilege('leadops_worker_test', 'approvals', 'SELECT') AS approvals,
         has_table_privilege('leadops_worker_test', 'approval_deliveries', 'SELECT') AS "approvalDeliveries",
         has_table_privilege('leadops_worker_test', 'email_deliveries', 'SELECT') AS "emailDeliveries"`,
    );
    expect(privileges).toEqual({ approvals: false, approvalDeliveries: false, emailDeliveries: false });

    const expirationJobs = await handle.worker.unsafe(
      'SELECT * FROM list_due_approval_expiration_jobs($1::integer)',
      [10],
    );
    const emailJobs = await handle.worker.unsafe<{ id: string }[]>(
      'SELECT * FROM list_due_email_delivery_jobs($1::integer)',
      [10],
    );
    expect(expirationJobs).toHaveLength(1);
    expect(emailJobs.map((row) => row.id)).toContain(email.id);
  });

  it('expires only approvals belonging to the active integration', async () => {
    const primary = await createPendingApproval(primaryIntegrationId, 'phase6-expire-primary');
    const secondary = await createPendingApproval(secondaryIntegrationId, 'phase6-expire-secondary');

    const expired = await withIntegrationContext(
      handle.worker,
      { organizationId, clientId, integrationId: primaryIntegrationId },
      async (tx) => expireApprovalsForTenant(
        sql(tx),
        organizationId,
        clientId,
        primaryIntegrationId,
      ),
    );
    expect(expired.map((row) => row.approval_id)).toEqual([primary.id]);

    const rows = await handle.owner.unsafe<{ id: string; status: string }[]>(
      'SELECT id, status FROM approvals WHERE id IN ($1::uuid, $2::uuid) ORDER BY id',
      [primary.id, secondary.id],
    );
    expect(rows.find((row) => row.id === primary.id)?.status).toBe('expired');
    expect(rows.find((row) => row.id === secondary.id)?.status).toBe('pending');
  });

  it('claims an exact approval delivery once under its integration binding', async () => {
    const approval = await createPendingApproval(primaryIntegrationId, 'phase6-exact-claim');
    await withIntegrationContext(
      handle.worker,
      { organizationId, clientId, integrationId: primaryIntegrationId },
      async (tx) => expireApprovalsForTenant(sql(tx), organizationId, clientId, primaryIntegrationId),
    );
    const [delivery] = await handle.owner.unsafe<{ id: string }[]>(
      'SELECT id FROM approval_deliveries WHERE "approvalId" = $1::uuid',
      [approval.id],
    );
    expect(delivery).toBeDefined();

    await expect(
      withIntegrationContext(
        handle.worker,
        { organizationId, clientId, integrationId: secondaryIntegrationId },
        async (tx) => claimApprovalDeliveryExact(sql(tx), {
          deliveryId: delivery?.id ?? '',
          organizationId,
          clientId,
          integrationId: primaryIntegrationId,
          workerId: 'wrong-binding-worker',
        }),
      ),
    ).rejects.toThrow();

    const binding = { organizationId, clientId, integrationId: primaryIntegrationId };
    const first = await withIntegrationContext(handle.worker, binding, async (tx) =>
      claimApprovalDeliveryExact(sql(tx), {
        ...binding,
        deliveryId: delivery?.id ?? '',
        workerId: 'exact-worker',
      }),
    );
    const second = await withIntegrationContext(handle.worker, binding, async (tx) =>
      claimApprovalDeliveryExact(sql(tx), {
        ...binding,
        deliveryId: delivery?.id ?? '',
        workerId: 'other-worker',
      }),
    );
    expect(first?.id).toBe(delivery?.id);
    expect(second).toBeNull();
  });

  it('keeps email creation idempotent and rejects immutable conflicts', async () => {
    const params = {
      organizationId,
      clientId,
      integrationId: primaryIntegrationId,
      templateName: 'approval-result',
      toEmail: 'customer@example.com',
      subject: 'Approved',
      htmlBody: '<p>Approved</p>',
      textBody: 'Approved',
      idempotencyKey: 'phase6-idempotent-email',
    };
    const [first, second] = await withTenantContext(handle.app, actor, async (tx) => [
      await createEmailDelivery(sql(tx), params),
      await createEmailDelivery(sql(tx), params),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    await expect(
      withTenantContext(handle.app, actor, async (tx) =>
        createEmailDelivery(sql(tx), { ...params, subject: 'Changed' }),
      ),
    ).rejects.toThrow();
  });

  it('requires trusted integration context for the email delivery lifecycle', async () => {
    const email = await withTenantContext(handle.app, actor, async (tx) =>
      createEmailDelivery(sql(tx), {
        organizationId,
        clientId,
        integrationId: primaryIntegrationId,
        templateName: 'workflow-failure',
        toEmail: 'operator@example.com',
        subject: 'Workflow failed',
        htmlBody: '<p>Workflow failed</p>',
        textBody: 'Workflow failed',
        idempotencyKey: 'phase6-email-lifecycle',
      }),
    );

    await expect(
      withIntegrationContext(
        handle.worker,
        { organizationId, clientId, integrationId: secondaryIntegrationId },
        async (tx) => tx.unsafe(
          'SELECT * FROM claim_email_delivery($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)',
          [email.id, organizationId, clientId, primaryIntegrationId, 'wrong-context-worker'],
        ),
      ),
    ).rejects.toThrow();

    const rows = await withIntegrationContext(
      handle.worker,
      { organizationId, clientId, integrationId: primaryIntegrationId },
      async (tx) => tx.unsafe(
        'SELECT * FROM claim_email_delivery($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)',
        [email.id, organizationId, clientId, primaryIntegrationId, 'email-worker'],
      ),
    );
    expect(rows).toHaveLength(1);
  });
});
