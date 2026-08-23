import { afterEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { Logger } from 'pino';
import type PgBoss from 'pg-boss';

import {
  createApprovalDeliveryEnqueueScheduler,
  createApprovalExpireScheduler,
  createEmailDeliveryEnqueueScheduler,
  createRetentionScheduler,
  createWeeklyReportScheduler,
  type SchedulerOptions,
} from './scheduler.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const binding = {
  organizationId: '00000000-0000-0000-0000-000000000001',
  clientId: '00000000-0000-0000-0000-000000000002',
  integrationId: '00000000-0000-0000-0000-000000000003',
};

function options(rows: Record<string, unknown>[]) {
  const unsafe = vi.fn().mockResolvedValue(rows);
  const send = vi.fn().mockResolvedValue('job-id');
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const value: SchedulerOptions = {
    logger,
    sql: { unsafe } as unknown as postgres.Sql,
    workerId: 'scheduler-test',
    pollIntervalMs: 60_000,
    batchSize: 10,
    getBoss: () => ({ send } as unknown as PgBoss),
  };
  return { value, unsafe, send };
}

describe('Phase 6A schedulers', () => {
  it('enqueues integration-scoped approval expiration jobs through the discovery function', async () => {
    const mock = options([binding]);
    await createApprovalExpireScheduler(mock.value).runOnce();

    expect(mock.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('list_due_approval_expiration_jobs'),
      [10],
    );
    expect(mock.send).toHaveBeenCalledWith(
      'approvals.expire',
      { schemaVersion: 1, ...binding },
      expect.objectContaining({ singletonKey: `approvals-expire-${binding.integrationId}` }),
    );
  });

  it('enqueues an exact approval delivery job', async () => {
    const deliveryId = '00000000-0000-0000-0000-000000000004';
    const mock = options([{ id: deliveryId, ...binding }]);
    await createApprovalDeliveryEnqueueScheduler(mock.value).runOnce();

    expect(mock.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('list_due_approval_delivery_jobs'),
      [10],
    );
    expect(mock.send).toHaveBeenCalledWith(
      'approvals.deliver-result',
      { schemaVersion: 1, deliveryId, ...binding },
      expect.objectContaining({ singletonKey: `approval-delivery-${deliveryId}` }),
    );
  });

  it('enqueues an integration-scoped email job', async () => {
    const deliveryId = '00000000-0000-0000-0000-000000000005';
    const mock = options([{ id: deliveryId, ...binding }]);
    await createEmailDeliveryEnqueueScheduler(mock.value).runOnce();

    expect(mock.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('list_due_email_delivery_jobs'),
      [10],
    );
    expect(mock.send).toHaveBeenCalledWith(
      'emails.send',
      { schemaVersion: 1, deliveryId, ...binding },
      expect.objectContaining({ singletonKey: `email-send-${deliveryId}` }),
    );
  });
});

describe('Phase 6C retention scheduler', () => {
  it('schedules a singleton dry-run by default', async () => {
    vi.stubEnv('RETENTION_ENABLED', 'false');
    const mock = options([]);

    await createRetentionScheduler(mock.value).runOnce();

    expect(mock.send).toHaveBeenCalledWith(
      'retention.prune-non-audit-data',
      { schemaVersion: 1, dryRun: true },
      expect.objectContaining({
        singletonKey: 'retention-prune-daily',
        singletonSeconds: 86_400,
      }),
    );
  });

  it('enables deletion only for the exact RETENTION_ENABLED=true value', async () => {
    vi.stubEnv('RETENTION_ENABLED', 'true');
    const mock = options([]);

    await createRetentionScheduler(mock.value).runOnce();

    expect(mock.send).toHaveBeenCalledWith(
      'retention.prune-non-audit-data',
      { schemaVersion: 1, dryRun: false },
      expect.any(Object),
    );
  });
});

describe('Phase 6B weekly report scheduler', () => {
  it('normalizes PostgreSQL timestamptz text to strict ISO datetimes', async () => {
    const mock = options([{
      ...binding,
      periodStart: '2026-08-03 00:00:00+00',
      periodEnd: '2026-08-10 00:00:00+00',
    }]);

    await createWeeklyReportScheduler(mock.value).runOnce();

    expect(mock.send).toHaveBeenCalledWith(
      'reports.generate-weekly',
      expect.objectContaining({
        periodStart: '2026-08-03T00:00:00.000Z',
        periodEnd: '2026-08-10T00:00:00.000Z',
      }),
      expect.any(Object),
    );
  });
});
