import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
} from '../test/fixtures.js';
import { pruneNonAuditData } from './retention.js';

describe('Phase 6C retention database contract', () => {
  let handle: FixtureHandle;
  let organizationId: string;
  let clientId: string;
  let integrationId: string;
  let approvalId: string;

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
    const fixture = await seedTenancyFixture(handle);
    organizationId = fixture.orgA.id;
    clientId = fixture.clients.a1.id;

    const integrations = await handle.owner.unsafe<{ id: string }[]>(
      `INSERT INTO integrations ("organizationId", "clientId", name, status)
       VALUES ($1, $2, 'retention-test', 'active') RETURNING id`,
      [organizationId, clientId],
    );
    integrationId = integrations[0]?.id ?? '';
    if (!integrationId) throw new Error('integration fixture was not created');

    const approvals = await handle.owner.unsafe<{ id: string }[]>(
      `INSERT INTO approvals (
         "organizationId", "clientId", "integrationId", idempotency_key,
         status, snapshot, expires_at, "createdAt", "updatedAt"
       ) VALUES ($1, $2, $3, 'retention-parent', 'approved', '{}'::jsonb,
                 now() + interval '1 day', now() - interval '120 days', now())
       RETURNING id`,
      [organizationId, clientId, integrationId],
    );
    approvalId = approvals[0]?.id ?? '';
    if (!approvalId) throw new Error('approval fixture was not created');

    await handle.owner.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO sessions (token, "userId", "expiresAt") VALUES
         ('retention-old-session-1', $1, now() - interval '100 days'),
         ('retention-old-session-2', $1, now() - interval '91 days'),
         ('retention-fresh-session', $1, now() - interval '10 days')`,
        [fixture.users.ownerA.id],
      );
      await tx.unsafe(
        `INSERT INTO verifications (identifier, value, "expiresAt") VALUES
         ('retention-old-1', 'value-1', now() - interval '100 days'),
         ('retention-old-2', 'value-2', now() - interval '91 days'),
         ('retention-fresh', 'value-3', now() - interval '10 days')`,
      );
      await tx.unsafe(
        `INSERT INTO outbox (
         "organizationId", "integrationId", "clientId", aggregate_type,
         aggregate_id, message_type, payload, status, "deliveredAt", "createdAt"
       ) VALUES
         ($1, $2, $3, 'retention', 'old-1', 'retention.test', '{}'::jsonb,
          'delivered', now() - interval '40 days', now() - interval '40 days'),
         ($1, $2, $3, 'retention', 'old-2', 'retention.test', '{}'::jsonb,
          'dead_letter', NULL, now() - interval '31 days'),
         ($1, $2, $3, 'retention', 'fresh', 'retention.test', '{}'::jsonb,
          'delivered', now() - interval '5 days', now() - interval '5 days')`,
        [organizationId, integrationId, clientId],
      );
      await tx.unsafe(
        `INSERT INTO email_deliveries (
         "organizationId", "clientId", "integrationId", template_name,
         to_email, subject, html_body, text_body, idempotency_key, status, "createdAt"
       ) VALUES
         ($1, $2, $3, 'retention', 'old1@example.com', 'old', '<p>old</p>', 'old',
          'retention-email-old-1', 'sent', now() - interval '100 days'),
         ($1, $2, $3, 'retention', 'old2@example.com', 'old', '<p>old</p>', 'old',
          'retention-email-old-2', 'permanent_failure', now() - interval '91 days'),
         ($1, $2, $3, 'retention', 'fresh@example.com', 'fresh', '<p>fresh</p>', 'fresh',
          'retention-email-fresh', 'sent', now() - interval '5 days')`,
        [organizationId, clientId, integrationId],
      );
      await tx.unsafe(
        `INSERT INTO approval_deliveries (
         "approvalId", "organizationId", "clientId", "integrationId",
         status, payload, idempotency_key, "createdAt"
       ) VALUES
         ($1, $2, $3, $4, 'delivered', '{}'::jsonb,
          'retention-approval-old-1', now() - interval '100 days'),
         ($1, $2, $3, $4, 'dead_letter', '{}'::jsonb,
          'retention-approval-old-2', now() - interval '91 days'),
         ($1, $2, $3, $4, 'delivered', '{}'::jsonb,
          'retention-approval-fresh', now() - interval '5 days')`,
        [approvalId, organizationId, clientId, integrationId],
      );
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('keeps dry-run and real deletion predicates identical and preserves protected rows', async () => {
    const preview = await pruneNonAuditData(handle.worker, true);
    const previewCounts = Object.fromEntries(
      preview.tables.map((table) => [table.tableName, table.candidateCount]),
    );

    expect(previewCounts).toMatchObject({
      sessions: 2,
      verifications: 2,
      outbox: 2,
      email_deliveries: 2,
      approval_deliveries: 2,
    });
    expect(preview.tables.every((table) => table.deletedCount === 0)).toBe(true);

    const applied = await pruneNonAuditData(handle.worker, false);
    expect(Object.fromEntries(applied.tables.map((table) => [table.tableName, table.deletedCount])))
      .toMatchObject(previewCounts);

    const remaining = await handle.owner.unsafe<{
      sessions: number;
      verifications: number;
      outbox: number;
      emails: number;
      deliveries: number;
      approvals: number;
    }[]>(
      `SELECT
         (SELECT count(*)::int FROM sessions) AS sessions,
         (SELECT count(*)::int FROM verifications) AS verifications,
         (SELECT count(*)::int FROM outbox) AS outbox,
         (SELECT count(*)::int FROM email_deliveries) AS emails,
         (SELECT count(*)::int FROM approval_deliveries) AS deliveries,
         (SELECT count(*)::int FROM approvals WHERE id = $1) AS approvals`,
      [approvalId],
    );
    expect(remaining[0]).toEqual({
      sessions: 1,
      verifications: 1,
      outbox: 1,
      emails: 1,
      deliveries: 1,
      approvals: 1,
    });
  });

  it('serializes concurrent pruning without duplicate deletion or leaked locks', async () => {
    const [first, second] = await Promise.all([
      pruneNonAuditData(handle.worker, false),
      pruneNonAuditData(handle.worker, false),
    ]);
    const totalDeleted = [...first.tables, ...second.tables]
      .reduce((sum, table) => sum + table.deletedCount, 0);
    expect(totalDeleted).toBe(10);

    await expect(pruneNonAuditData(handle.worker, true)).resolves.toMatchObject({ dryRun: true });
  });

  it('allows only worker execution and keeps protected tables non-writable', async () => {
    await expect(pruneNonAuditData(handle.app, true)).rejects.toThrow(/permission denied/i);
    await expect(
      handle.worker.unsafe('DELETE FROM approvals WHERE id = $1', [approvalId]),
    ).rejects.toThrow(/permission denied/i);
  });
});
