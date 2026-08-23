import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withIntegrationContext, withTenantContext } from '../tenancy/context.js';
import {
  acknowledgeIncidentForTenant,
  getIncidentEvents,
  openOrAggregateIncident,
  resolveIncidentForTenant,
} from './incidents.js';
import {
  computeClientPeriodMetrics,
  createReportSnapshot,
} from './reports.js';
import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
  type TenancyFixture,
} from '../test/fixtures.js';

const PERIOD_START = '2024-01-01T00:00:00.000Z';
const PERIOD_END = '2024-01-08T00:00:00.000Z';

function sql(value: unknown): postgres.Sql {
  return value as postgres.Sql;
}

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('expected a database row');
  return row;
}

describe('Phase 6B incident and report database contract', () => {
  let handle: FixtureHandle;
  let fixture: TenancyFixture;
  let integrationA1: string;

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
    fixture = await seedTenancyFixture(handle);
    integrationA1 = await createIntegration(
      fixture.orgA.id,
      fixture.clients.a1.id,
      'phase6b-primary',
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  async function createIntegration(
    organizationId: string,
    clientId: string,
    name: string,
  ): Promise<string> {
    const rows = await handle.owner.unsafe<{ id: string }[]>(
      `INSERT INTO integrations ("organizationId", "clientId", name, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [organizationId, clientId, name],
    );
    return first(rows).id;
  }

  function machine<T>(
    organizationId: string,
    clientId: string,
    integrationId: string,
    callback: (tx: postgres.Sql) => Promise<T>,
  ): Promise<T> {
    return withIntegrationContext(handle.worker, {
      organizationId,
      clientId,
      integrationId,
    }, (tx) => callback(sql(tx)));
  }

  function user<T>(callback: (tx: postgres.Sql) => Promise<T>): Promise<T> {
    return withTenantContext(handle.app, {
      userId: fixture.users.ownerA.id,
      organizationId: fixture.orgA.id,
      role: 'agency_owner',
    }, (tx) => callback(sql(tx)));
  }

  function openIncident(
    occurrenceKey: string,
    fingerprint = 'phase6b-fingerprint',
    organizationId = fixture.orgA.id,
    clientId = fixture.clients.a1.id,
    integrationId = integrationA1,
  ) {
    return machine(organizationId, clientId, integrationId, (tx) =>
      openOrAggregateIncident(tx, {
        organizationId,
        clientId,
        integrationId,
        occurrenceKey,
        fingerprint,
        category: 'permanent',
        severity: 'critical',
        errorSummary: 'fixture failure',
        jobName: 'events.project',
        correlationId: occurrenceKey,
      }));
  }

  it('creates an incident and one immutable opened event', async () => {
    const incident = await openIncident('occurrence-create');
    expect(incident).toMatchObject({
      fingerprint: 'phase6b-fingerprint',
      status: 'open',
      occurrenceCount: 1,
      isNew: true,
      wasApplied: true,
    });

    const events = await user((tx) => getIncidentEvents(tx, {
      organizationId: fixture.orgA.id,
      incidentId: incident.id,
    }));
    expect(events).toHaveLength(1);
    expect(first(events)).toMatchObject({
      eventType: 'opened',
      occurrenceKey: 'occurrence-create',
      correlationId: 'occurrence-create',
    });
  });

  it('does not count the same occurrence twice', async () => {
    const firstResult = await openIncident('occurrence-replay');
    const replay = await openIncident('occurrence-replay');
    expect(replay.id).toBe(firstResult.id);
    expect(replay.occurrenceCount).toBe(1);
    expect(replay.wasApplied).toBe(false);

    const rows = await handle.owner.unsafe<{ count: number }[]>(
      `SELECT count(*)::integer AS count FROM incident_events
       WHERE "incidentId" = $1`,
      [firstResult.id],
    );
    expect(first(rows).count).toBe(1);
  });

  it('aggregates distinct occurrences under the same fingerprint', async () => {
    const firstResult = await openIncident('occurrence-1');
    const second = await openIncident('occurrence-2');
    expect(second.id).toBe(firstResult.id);
    expect(second.occurrenceCount).toBe(2);
    expect(second.isNew).toBe(false);
    expect(second.wasApplied).toBe(true);
  });

  it('atomically aggregates 100 concurrent first occurrences', async () => {
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      openIncident(`concurrent-${String(index)}`, 'concurrent-fingerprint')));

    const rows = await handle.owner.unsafe<{ incidents: number; occurrences: number }[]>(
      `SELECT
         count(DISTINCT i.id)::integer AS incidents,
         max(i."occurrenceCount")::integer AS occurrences
       FROM incidents i
       WHERE i."organizationId" = $1
         AND i."clientId" = $2
         AND i.fingerprint = 'concurrent-fingerprint'`,
      [fixture.orgA.id, fixture.clients.a1.id],
    );
    expect(first(rows)).toEqual({ incidents: 1, occurrences: 100 });
  });

  it('keeps identical fingerprints separated by client', async () => {
    const integrationA2 = await createIntegration(
      fixture.orgA.id,
      fixture.clients.a2.id,
      'phase6b-secondary-client',
    );
    const a1 = await openIncident('client-a1', 'shared-fingerprint');
    const a2 = await openIncident(
      'client-a2',
      'shared-fingerprint',
      fixture.orgA.id,
      fixture.clients.a2.id,
      integrationA2,
    );
    expect(a2.id).not.toBe(a1.id);
  });

  it('acknowledges, resolves, and reopens with audited correlation ids', async () => {
    const incident = await openIncident('lifecycle-open');
    await user((tx) => acknowledgeIncidentForTenant(tx, {
      incidentId: incident.id,
      organizationId: fixture.orgA.id,
      actor: fixture.users.ownerA.id,
      expectedStatus: 'open',
      correlationId: 'lifecycle-ack',
    }));
    await user((tx) => resolveIncidentForTenant(tx, {
      incidentId: incident.id,
      organizationId: fixture.orgA.id,
      actor: fixture.users.ownerA.id,
      expectedStatus: 'acknowledged',
      correlationId: 'lifecycle-resolve',
    }));
    const reopened = await openIncident('lifecycle-reopen');
    expect(reopened).toMatchObject({ id: incident.id, status: 'open', occurrenceCount: 2 });

    const events = await user((tx) => getIncidentEvents(tx, {
      organizationId: fixture.orgA.id,
      incidentId: incident.id,
    }));
    expect(events.map((event) => event.eventType)).toEqual([
      'opened', 'acknowledged', 'resolved', 'reopened',
    ]);
    expect(events.map((event) => event.correlationId)).toEqual([
      'lifecycle-open', 'lifecycle-ack', 'lifecycle-resolve', 'lifecycle-reopen',
    ]);
  });

  it('rejects stale incident state transitions', async () => {
    const incident = await openIncident('stale-transition');
    await user((tx) => acknowledgeIncidentForTenant(tx, {
      incidentId: incident.id,
      organizationId: fixture.orgA.id,
      actor: fixture.users.ownerA.id,
      expectedStatus: 'open',
      correlationId: 'stale-first',
    }));
    await expect(user((tx) => acknowledgeIncidentForTenant(tx, {
      incidentId: incident.id,
      organizationId: fixture.orgA.id,
      actor: fixture.users.ownerA.id,
      expectedStatus: 'open',
      correlationId: 'stale-second',
    }))).rejects.toThrow(/only open incidents|status has changed/);
  });

  it('rejects incident transitions from client roles and forged actors', async () => {
    const incident = await openIncident('unauthorized-transition');
    const viewer = (callback: (tx: postgres.Sql) => Promise<unknown>) =>
      withTenantContext(handle.app, {
        userId: fixture.users.clientViewerA.id,
        organizationId: fixture.orgA.id,
        role: 'client_viewer',
        clientId: fixture.clients.a1.id,
      }, (tx) => callback(sql(tx)));

    await expect(viewer((tx) => acknowledgeIncidentForTenant(tx, {
      incidentId: incident.id,
      organizationId: fixture.orgA.id,
      actor: fixture.users.clientViewerA.id,
      expectedStatus: 'open',
      correlationId: 'viewer-denied',
    }))).rejects.toThrow(/not authorized/);

    await expect(user((tx) => acknowledgeIncidentForTenant(tx, {
      incidentId: incident.id,
      organizationId: fixture.orgA.id,
      actor: fixture.users.clientViewerA.id,
      expectedStatus: 'open',
      correlationId: 'forged-actor-denied',
    }))).rejects.toThrow(/not authorized/);
  });

  it('blocks direct mutation of incident events and report snapshots', async () => {
    const incident = await openIncident('immutable-event');
    await expect(user((tx) => tx.unsafe(
      `UPDATE incident_events SET metadata = '{}'::jsonb WHERE "incidentId" = $1`,
      [incident.id],
    ))).rejects.toThrow();

    const snapshot = await createSnapshot(1, 'immutable-snapshot');
    await expect(user((tx) => tx.unsafe(
      `UPDATE report_snapshots SET metrics = '{}'::jsonb WHERE id = $1`,
      [snapshot.id],
    ))).rejects.toThrow();
  });

  it('rejects a forged integration binding inside definer functions', async () => {
    const forged = crypto.randomUUID();
    await expect(machine(
      fixture.orgA.id,
      fixture.clients.a1.id,
      integrationA1,
      (tx) => openOrAggregateIncident(tx, {
        organizationId: fixture.orgA.id,
        clientId: fixture.clients.a1.id,
        integrationId: forged,
        occurrenceKey: 'forged-binding',
        fingerprint: 'forged-binding',
        category: 'permanent',
      }),
    )).rejects.toThrow(/not authorized|binding is invalid/);
  });

  const baseMetrics = {
    leadsReceived: 0,
    qualificationRate: 0,
    approvalConversion: 0,
    appointments: 0,
    workflowSuccess: 0,
    workflowFailure: 0,
    openIncidents: 0,
    resolvedIncidents: 0,
  };

  function createSnapshot(generationVersion: number, correlationId: string) {
    return machine(
      fixture.orgA.id,
      fixture.clients.a1.id,
      integrationA1,
      (tx) => createReportSnapshot(tx, {
        organizationId: fixture.orgA.id,
        clientId: fixture.clients.a1.id,
        integrationId: integrationA1,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        generationVersion,
        metrics: baseMetrics,
        correlationId,
      }),
    );
  }

  it('creates one snapshot under concurrent idempotent generation', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      createSnapshot(1, `snapshot-${String(index)}`)));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it('keeps different report generation versions immutable and coexisting', async () => {
    const version1 = await createSnapshot(1, 'version-1');
    const replay = await createSnapshot(1, 'version-1-replay');
    const version2 = await createSnapshot(2, 'version-2');
    expect(replay).toMatchObject({ id: version1.id, created: false });
    expect(version2.id).not.toBe(version1.id);
    expect(version2.generationVersion).toBe(2);
  });

  it('computes deterministic zero metrics on an empty week', async () => {
    const metrics = await machine(
      fixture.orgA.id,
      fixture.clients.a1.id,
      integrationA1,
      (tx) => computeClientPeriodMetrics(tx, {
        organizationId: fixture.orgA.id,
        clientId: fixture.clients.a1.id,
        integrationId: integrationA1,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    );
    expect(metrics).toEqual({
      leadsReceived: 0,
      qualifiedLeads: 0,
      totalLeads: 0,
      approvals: 0,
      approvedDecisions: 0,
      rejectedDecisions: 0,
      appointments: 0,
      workflowSuccess: 0,
      workflowFailure: 0,
      openIncidents: 0,
      resolvedIncidents: 0,
    });
  });

  it('aggregates client metrics across multiple integrations', async () => {
    const secondIntegration = await createIntegration(
      fixture.orgA.id,
      fixture.clients.a1.id,
      'phase6b-second-integration',
    );
    await handle.owner.unsafe(
      `INSERT INTO leads (
         "organizationId", "clientId", source, "externalId", "dedupeKey",
         status, "receivedAt"
       ) VALUES ($1, $2, 'fixture', 'lead-1', 'fixture:lead-1', 'qualified', $3)`,
      [fixture.orgA.id, fixture.clients.a1.id, PERIOD_START],
    );
    await handle.owner.unsafe(
      `INSERT INTO business_events (
         "integrationId", "organizationId", "clientId", "webhookId", "eventType",
         raw_json, body_hash, status, "receivedAt"
       ) VALUES ($1, $2, $3, 'appointment-1', 'appointment.booked', '{}', 'hash', 'projected', $4)`,
      [secondIntegration, fixture.orgA.id, fixture.clients.a1.id, PERIOD_START],
    );
    const workflows = await handle.owner.unsafe<{ id: string }[]>(
      `INSERT INTO workflows (
         "organizationId", "clientId", "integrationId", "externalId", name
       ) VALUES ($1, $2, $3, 'workflow-1', 'Workflow 1') RETURNING id`,
      [fixture.orgA.id, fixture.clients.a1.id, secondIntegration],
    );
    await handle.owner.unsafe(
      `INSERT INTO workflow_runs (
         "organizationId", "clientId", "workflowId", "externalRunId", status, "succeededAt"
       ) VALUES ($1, $2, $3, 'run-1', 'succeeded', $4)`,
      [fixture.orgA.id, fixture.clients.a1.id, first(workflows).id, PERIOD_START],
    );

    const metrics = await machine(
      fixture.orgA.id,
      fixture.clients.a1.id,
      integrationA1,
      (tx) => computeClientPeriodMetrics(tx, {
        organizationId: fixture.orgA.id,
        clientId: fixture.clients.a1.id,
        integrationId: integrationA1,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    );
    expect(metrics).toMatchObject({
      leadsReceived: 1,
      qualifiedLeads: 1,
      appointments: 1,
      workflowSuccess: 1,
    });
  });

  it('discovers one due client per generation version and then stops rediscovery', async () => {
    const dueBefore = await handle.worker.unsafe<{ clientId: string }[]>(
      `SELECT "clientId" FROM list_due_weekly_report_clients(100, 1)
       WHERE "organizationId" = $1 AND "clientId" = $2`,
      [fixture.orgA.id, fixture.clients.a1.id],
    );
    expect(dueBefore).toHaveLength(1);

    const periodRows = await handle.worker.unsafe<{ periodStart: Date; periodEnd: Date }[]>(
      `SELECT "periodStart", "periodEnd"
       FROM list_due_weekly_report_clients(100, 1)
       WHERE "organizationId" = $1 AND "clientId" = $2`,
      [fixture.orgA.id, fixture.clients.a1.id],
    );
    const period = first(periodRows);
    await machine(
      fixture.orgA.id,
      fixture.clients.a1.id,
      integrationA1,
      (tx) => createReportSnapshot(tx, {
        organizationId: fixture.orgA.id,
        clientId: fixture.clients.a1.id,
        integrationId: integrationA1,
        periodStart: period.periodStart.toISOString(),
        periodEnd: period.periodEnd.toISOString(),
        generationVersion: 1,
        metrics: baseMetrics,
      }),
    );

    const dueAfter = await handle.worker.unsafe<{ clientId: string }[]>(
      `SELECT "clientId" FROM list_due_weekly_report_clients(100, 1)
       WHERE "organizationId" = $1 AND "clientId" = $2`,
      [fixture.orgA.id, fixture.clients.a1.id],
    );
    expect(dueAfter).toHaveLength(0);
  });

  it('keeps incidents and snapshots invisible to another organization context', async () => {
    const incident = await openIncident('rls-isolation');
    const snapshot = await createSnapshot(1, 'rls-snapshot');
    const rows = await withTenantContext(handle.app, {
      userId: fixture.users.ownerB.id,
      organizationId: fixture.orgB.id,
      role: 'agency_owner',
    }, async (tx) => tx.unsafe<{ incidents: number; snapshots: number }[]>(
      `SELECT
         (SELECT count(*)::integer FROM incidents WHERE id = $1) AS incidents,
         (SELECT count(*)::integer FROM report_snapshots WHERE id = $2) AS snapshots`,
      [incident.id, snapshot.id],
    ));
    expect(first(rows)).toEqual({ incidents: 0, snapshots: 0 });
  });
});
