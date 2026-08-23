import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type postgres from 'postgres';

import { createLogger } from '@leadops/observability';
import {
  consumeTokenAndDecide,
  createApproval,
  createApprovalToken,
  createIntegration,
  decideApproval,
  upsertLeadAndInsertHistory,
  withIntegrationContext,
  withTenantContext,
} from '@leadops/db';
import type { LeadReceivedEvent } from '@leadops/events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
  type TenancyFixture,
} from '../../../packages/db/src/test/fixtures.js';
import { processApprovalDeliveries } from '../../worker/src/approval-callback.js';
import {
  processQualificationJob,
  projectLeadReceived,
  resetQualificationProviderFactory,
  setQualificationProviderFactory,
} from '../../worker/src/lead-projectors.js';

function sql(value: unknown): postgres.Sql {
  return value as postgres.Sql;
}

describe('Phase 5 sellable approval pipeline E2E', () => {
  let fixture: FixtureHandle;
  let seeded: TenancyFixture;
  let integration: Awaited<ReturnType<typeof createIntegration>>;
  let callbackUrl: string;
  let callbackStatus = 204;
  const callbackPayloads: Record<string, unknown>[] = [];
  const crmActions: string[] = [];
  const log = createLogger({ service: 'phase5-e2e' });

  const callbackServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      callbackPayloads.push(parsed);
      if (callbackStatus >= 200 && callbackStatus < 300 && parsed.status === 'approved') {
        crmActions.push(String(parsed.approvalId));
      }
      response.writeHead(callbackStatus).end();
    });
  });

  const actor = () => ({
    userId: seeded.users.ownerA.id,
    organizationId: seeded.orgA.id,
    role: 'agency_owner' as const,
  });

  beforeAll(async () => {
    process.env.LEADOPS_ENCRYPTION_KEY = '0'.repeat(64);
    fixture = createFixtureHandle();
    await new Promise<void>((resolve, reject) => {
      callbackServer.once('error', reject);
      callbackServer.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = callbackServer.address() as AddressInfo;
    callbackUrl = `http://n8n-callback.localhost:${String(address.port)}/approval`;
  });

  beforeEach(async () => {
    await resetSchema(fixture);
    seeded = await seedTenancyFixture(fixture);
    callbackPayloads.length = 0;
    crmActions.length = 0;
    callbackStatus = 204;
    integration = await withTenantContext(fixture.app, actor(), (tx) =>
      createIntegration(sql(tx), {
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
        name: 'Phase 5 E2E n8n callback',
        callbackUrl,
      }),
    );
  });

  afterEach(() => {
    resetQualificationProviderFactory();
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

  async function insertLead(externalId: string): Promise<string> {
    const result = await withIntegrationContext(fixture.app, {
      integrationId: integration.integration.id,
      organizationId: seeded.orgA.id,
      clientId: seeded.clients.a1.id,
    }, (tx) => upsertLeadAndInsertHistory(sql(tx), {
      organizationId: seeded.orgA.id,
      clientId: seeded.clients.a1.id,
      source: 'phase5-e2e',
      externalId,
      contactName: 'E2E Contact',
      email: 'e2e@example.com',
      phone: null,
      company: 'E2E Corp',
      message: 'Please contact me about the enterprise plan',
      receivedAt: new Date().toISOString(),
    }));
    return result.id;
  }

  function configureQualification(mode: 'high' | 'review' | 'failure'): void {
    setQualificationProviderFactory(() => ({
      provider: {
        qualify() {
          if (mode === 'failure') return Promise.reject(new Error('fixture AI unavailable'));
          const high = mode === 'high';
          return Promise.resolve({
            qualification: {
              schemaVersion: 1 as const,
              score: high ? 95 : 55,
              decision: high ? 'qualified' as const : 'needs_review' as const,
              reasons: [high ? 'Strong buying intent' : 'Human context required'],
              summary: high ? 'High confidence qualified lead' : 'Review before action',
              suggestedNextAction: high ? 'book_call' as const : 'request_approval' as const,
              confidence: high ? 0.96 : 0.62,
              riskFlags: [],
            },
            usage: { input: 100, output: 40 },
            cost: { amountMinor: 1, currency: 'USD' },
          });
        },
      },
      providerName: 'phase5-e2e-provider',
      modelName: 'fixture-v1',
    }));
  }

  async function qualifyLead(leadId: string, mode: 'high' | 'review' | 'failure'): Promise<void> {
    configureQualification(mode);
    await processQualificationJob(log, {
      leadId,
      organizationId: seeded.orgA.id,
      clientId: seeded.clients.a1.id,
      integrationId: integration.integration.id,
    }, fixture.worker);
  }

  async function createApprovalForLead(
    leadId: string,
    correlationId: string,
  ): Promise<Awaited<ReturnType<typeof createApproval>>> {
    const [lead] = await fixture.owner.unsafe<{
      contactName: string | null;
      company: string | null;
      score: number | null;
      qualificationSummary: string | null;
      qualificationDecision: string | null;
      suggestedNextAction: string | null;
    }[]>(
      `SELECT "contactName", company, score, "qualificationSummary",
              "qualificationDecision", "suggestedNextAction"
       FROM leads WHERE id = $1`,
      [leadId],
    );
    if (!lead) throw new Error('qualified lead fixture was not found');
    return withTenantContext(fixture.app, actor(), (tx) => createApproval(sql(tx), {
      organizationId: seeded.orgA.id,
      clientId: seeded.clients.a1.id,
      integrationId: integration.integration.id,
      leadId,
      correlationId,
      snapshot: {
        leadId,
        contactName: lead.contactName,
        company: lead.company,
        score: lead.score,
        qualificationSummary: lead.qualificationSummary,
        qualificationDecision: lead.qualificationDecision,
        suggestedNextAction: lead.suggestedNextAction,
      },
      requestedBy: actor().userId,
    }));
  }

  async function dispatch(workerId: string): Promise<number> {
    return processApprovalDeliveries(fixture.worker, workerId, 10, {
      allowLocalhost: true,
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    });
  }

  it('high score → human approval → signed n8n callback → one CRM action', async () => {
    const leadId = await insertLead('phase5-high-score');
    await qualifyLead(leadId, 'high');
    const approval = await createApprovalForLead(leadId, 'phase5-high-score');
    const decision = await withTenantContext(fixture.app, actor(), (tx) =>
      decideApproval(sql(tx), {
        approvalId: approval.id,
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
        decision: 'approved',
        decidedBy: actor().userId,
        expectedVersion: 1,
      }),
    );
    expect(decision.decided).toBe(true);
    await expect(dispatch('phase5-high-worker')).resolves.toBe(1);
    expect(callbackPayloads).toEqual([expect.objectContaining({
      eventType: 'approval.completed',
      approvalId: approval.id,
      status: 'approved',
    })]);
    expect(crmActions).toEqual([approval.id]);
  });

  it('needs review → public human rejection → callback without CRM mutation', async () => {
    const leadId = await insertLead('phase5-human-reject');
    await qualifyLead(leadId, 'review');
    const approval = await createApprovalForLead(leadId, 'phase5-human-reject');
    const token = await withTenantContext(fixture.app, actor(), (tx) =>
      createApprovalToken(sql(tx), {
        approvalId: approval.id,
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
      }),
    );
    const decision = await consumeTokenAndDecide(
      fixture.app,
      token.token,
      'rejected',
      'public_token',
      'Customer declined',
    );
    expect(decision).toMatchObject({ decided: true, status: 'rejected' });
    await expect(dispatch('phase5-reject-worker')).resolves.toBe(1);
    expect(callbackPayloads[0]).toMatchObject({ approvalId: approval.id, status: 'rejected' });
    expect(crmActions).toEqual([]);
  });

  it('AI failure records a safe needs-review outcome and triggers no external action', async () => {
    const leadId = await insertLead('phase5-ai-failure');
    await qualifyLead(leadId, 'failure');
    const [state] = await fixture.owner.unsafe<{
      lead_status: string;
      ai_status: string;
      error_classification: string;
      result: unknown;
    }[]>(
      `SELECT l.status AS lead_status, a.status AS ai_status,
              a."errorClassification" AS error_classification, a.result
       FROM leads l JOIN ai_runs a ON a."leadId" = l.id
       WHERE l.id = $1`,
      [leadId],
    );
    expect(state).toEqual({
      lead_status: 'needs_review',
      ai_status: 'schema_error',
      error_classification: 'PROVIDER_ERROR',
      result: null,
    });
    expect(callbackPayloads).toEqual([]);
    expect(crmActions).toEqual([]);
  });

  it('CRM/n8n failure retries delivery without rolling back or duplicating the decision', async () => {
    const leadId = await insertLead('phase5-crm-failure');
    await qualifyLead(leadId, 'high');
    const approval = await createApprovalForLead(leadId, 'phase5-crm-failure');
    await withTenantContext(fixture.app, actor(), (tx) => decideApproval(sql(tx), {
      approvalId: approval.id,
      organizationId: seeded.orgA.id,
      clientId: seeded.clients.a1.id,
      decision: 'approved',
      decidedBy: actor().userId,
    }));
    callbackStatus = 503;
    await expect(dispatch('phase5-crm-failure-worker')).resolves.toBe(1);
    const [state] = await fixture.owner.unsafe<{
      approval_status: string;
      delivery_status: string;
      attempt_count: number;
      decisions: string;
    }[]>(
      `SELECT
         (SELECT status FROM approvals WHERE id = $1) AS approval_status,
         (SELECT status FROM approval_deliveries WHERE "approvalId" = $1) AS delivery_status,
         (SELECT attempt_count FROM approval_deliveries WHERE "approvalId" = $1) AS attempt_count,
         (SELECT count(*) FROM approval_history
           WHERE "approvalId" = $1 AND new_status = 'approved') AS decisions`,
      [approval.id],
    );
    expect(state).toEqual({
      approval_status: 'approved',
      delivery_status: 'pending',
      attempt_count: 1,
      decisions: '1',
    });
    expect(crmActions).toEqual([]);
  });

  it('duplicate source events collapse to one lead, qualification job, approval, and callback', async () => {
    const event: LeadReceivedEvent = {
      specVersion: '1.0',
      eventId: '00000000-0000-4000-8000-000000000551',
      eventType: 'lead.received',
      occurredAt: new Date().toISOString(),
      source: 'phase5-e2e',
      organizationId: seeded.orgA.id,
      clientId: seeded.clients.a1.id,
      data: {
        lead: {
          id: 'phase5-duplicate-event',
          name: 'Duplicate Contact',
          email: 'duplicate@example.com',
          message: 'Deduplicate me',
        },
      },
      metadata: { schemaVersion: '1.0', correlationId: 'phase5-duplicate-correlation' },
    };
    const binding = {
      integrationId: integration.integration.id,
      organizationId: seeded.orgA.id,
      clientId: seeded.clients.a1.id,
    };
    await withIntegrationContext(fixture.app, binding, async (tx) => {
      await projectLeadReceived(sql(tx), event, binding);
      await projectLeadReceived(sql(tx), event, binding);
    });
    const [lead] = await fixture.owner.unsafe<{ id: string }[]>(
      `SELECT id FROM leads WHERE "externalId" = 'phase5-duplicate-event'`,
    );
    if (!lead) throw new Error('deduplicated lead was not created');
    configureQualification('high');
    await processQualificationJob(log, { leadId: lead.id, ...binding }, fixture.worker);

    const first = await createApprovalForLead(lead.id, 'phase5-duplicate-correlation');
    const second = await createApprovalForLead(lead.id, 'phase5-duplicate-correlation');
    expect(second.id).toBe(first.id);
    await withTenantContext(fixture.app, actor(), (tx) => decideApproval(sql(tx), {
      approvalId: first.id,
      organizationId: seeded.orgA.id,
      clientId: seeded.clients.a1.id,
      decision: 'approved',
      decidedBy: actor().userId,
    }));
    await expect(dispatch('phase5-duplicate-worker')).resolves.toBe(1);

    const [counts] = await fixture.owner.unsafe<{
      leads: string;
      qualifications: string;
      approvals: string;
      deliveries: string;
    }[]>(
      `SELECT
         (SELECT count(*) FROM leads WHERE "externalId" = 'phase5-duplicate-event') AS leads,
         (SELECT count(*) FROM outbox WHERE aggregate_id = $1 AND message_type = 'leads.qualify') AS qualifications,
         (SELECT count(*) FROM approvals WHERE correlation_id = 'phase5-duplicate-correlation') AS approvals,
         (SELECT count(*) FROM approval_deliveries WHERE "approvalId" = $2) AS deliveries`,
      [lead.id, first.id],
    );
    expect(counts).toEqual({ leads: '1', qualifications: '1', approvals: '1', deliveries: '1' });
    expect(crmActions).toEqual([first.id]);
  });
});
