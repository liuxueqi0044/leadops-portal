import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type postgres from "postgres";

import {
  claimOutboxItems,
  createOutboxMessage,
  getFailedEvents,
  markEventFailed,
  markEventProjected,
  markOutboxDelivered,
  markOutboxFailed,
  receiveBusinessEvent,
} from "./events.js";
import { createIntegration } from "./integrations.js";
import { withIntegrationContext, withTenantContext } from "../tenancy/context.js";
import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
} from "../test/fixtures.js";

describe("event persistence and outbox", () => {
  let handle: FixtureHandle;
  let organizationId: string;
  let clientId: string;
  let integrationId: string;
  let actor: { userId: string; organizationId: string; role: "agency_owner" };

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
    const seeded = await seedTenancyFixture(handle);
    organizationId = seeded.orgA.id;
    clientId = seeded.clients.a1.id;
    actor = {
      userId: seeded.users.ownerA.id,
      organizationId,
      role: "agency_owner",
    };
    const created = await withTenantContext(handle.app, actor, async (tx) =>
      createIntegration(tx as unknown as postgres.Sql, {
        organizationId,
        clientId,
        name: "Event DB test",
      }),
    );
    integrationId = created.integration.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function receive(webhookId: string, bodyHash = `hash-${webhookId}`) {
    return withIntegrationContext(
      handle.app,
      { integrationId, organizationId, clientId },
      async (tx) =>
        receiveBusinessEvent(tx as unknown as postgres.Sql, {
          integrationId,
          organizationId,
          clientId,
          webhookId,
          eventType: "workflow.run.started",
          rawJson: { webhookId, nested: { retained: true } },
          bodyHash,
        }),
    );
  }

  async function receiveWithOutbox(webhookId: string) {
    return withIntegrationContext(
      handle.app,
      { integrationId, organizationId, clientId },
      async (tx) => {
        const sql = tx as unknown as postgres.Sql;
        const received = await receiveBusinessEvent(sql, {
          integrationId,
          organizationId,
          clientId,
          webhookId,
          eventType: "workflow.run.started",
          rawJson: { webhookId, nested: { retained: true } },
          bodyHash: `hash-${webhookId}`,
        });
        if (!received.isDuplicate) {
          await createOutboxMessage(sql, {
            organizationId,
            integrationId,
            clientId,
            aggregateType: "business_event",
            aggregateId: received.businessEvent.id,
            messageType: "events.project",
            payload: {
              eventId: received.businessEvent.id,
              eventType: "workflow.run.started",
              integrationId,
              organizationId,
              clientId,
            },
          });
        }
        return received;
      },
    );
  }

  it("stores JSON as an object and commits event plus outbox atomically", async () => {
    const result = await receiveWithOutbox("atomic-1");
    expect(result.isDuplicate).toBe(false);

    const rows = await handle.owner.unsafe<{
      raw_json: unknown;
      outbox_count: string;
    }[]>(
      `SELECT e.raw_json,
              (SELECT count(*) FROM outbox o WHERE o.aggregate_id = e.id::text) AS outbox_count
       FROM business_events e WHERE e.id = $1`,
      [result.businessEvent.id],
    );
    expect(rows[0]?.raw_json).toEqual({ webhookId: "atomic-1", nested: { retained: true } });
    expect(Number(rows[0]?.outbox_count)).toBe(1);
  });

  it("rolls event and outbox back together", async () => {
    await expect(
      withIntegrationContext(
        handle.app,
        { integrationId, organizationId, clientId },
        async (tx) => {
          const sql = tx as unknown as postgres.Sql;
          const event = await receiveBusinessEvent(sql, {
            integrationId,
            organizationId,
            clientId,
            webhookId: "rollback-1",
            eventType: "workflow.run.started",
            rawJson: { rollback: true },
            bodyHash: "rollback-hash",
          });
          await createOutboxMessage(sql, {
            organizationId,
            integrationId,
            clientId,
            aggregateType: "business_event",
            aggregateId: event.businessEvent.id,
            messageType: "events.project",
            payload: { eventId: event.businessEvent.id },
          });
          throw new Error("failure injection");
        },
      ),
    ).rejects.toThrow("failure injection");

    const rows = await handle.owner.unsafe(`SELECT id FROM business_events WHERE "webhookId" = 'rollback-1'`);
    expect(rows).toHaveLength(0);
  });

  it("returns duplicate for the same body and mismatch for a changed body", async () => {
    expect((await receive("duplicate-1", "same")).isDuplicate).toBe(false);
    const duplicate = await receive("duplicate-1", "same");
    expect(duplicate).toMatchObject({ isDuplicate: true, bodyMismatch: false });
    const mismatch = await receive("duplicate-1", "different");
    expect(mismatch).toMatchObject({ isDuplicate: true, bodyMismatch: true });
  });

  it("collapses 20 concurrent deliveries to one event and one outbox row", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => receiveWithOutbox("concurrent-20")),
    );
    expect(results.filter((result) => !result.isDuplicate)).toHaveLength(1);

    const [counts] = await handle.owner.unsafe<{ events: string; outbox: string }[]>(
      `SELECT
         (SELECT count(*) FROM business_events WHERE "integrationId" = $1 AND "webhookId" = $2) AS events,
         (SELECT count(*) FROM outbox WHERE aggregate_id = (
           SELECT id::text FROM business_events WHERE "integrationId" = $1 AND "webhookId" = $2
         )) AS outbox`,
      [integrationId, "concurrent-20"],
    );
    expect(Number(counts?.events)).toBe(1);
    expect(Number(counts?.outbox)).toBe(1);
  });

  it("prevents tenant-key substitution even with a valid integration context", async () => {
    const seeded = await seedTenancyFixtureAfterResetIsNotNeeded();
    await expect(
      withIntegrationContext(
        handle.app,
        { integrationId, organizationId, clientId },
        async (tx) =>
          receiveBusinessEvent(tx as unknown as postgres.Sql, {
            integrationId,
            organizationId,
            clientId: seeded.foreignClientId,
            webhookId: "tenant-substitution",
            eventType: "workflow.run.started",
            rawJson: {},
            bodyHash: "tenant-substitution",
          }),
      ),
    ).rejects.toThrow();
  });

  async function seedTenancyFixtureAfterResetIsNotNeeded(): Promise<{ foreignClientId: string }> {
    const rows = await handle.owner.unsafe<{ id: string }[]>(
      `SELECT id FROM clients WHERE "organizationId" <> $1 ORDER BY id LIMIT 1`,
      [organizationId],
    );
    const foreignClientId = rows[0]?.id;
    if (!foreignClientId) throw new Error("foreign client fixture missing");
    return { foreignClientId };
  }

  it("claims without overlap, enforces lock ownership, and retains delivered rows", async () => {
    for (let i = 0; i < 12; i += 1) await receiveWithOutbox(`claim-${String(i)}`);

    await expect(claimOutboxItems(handle.app, "web-role", 1)).rejects.toThrow();

    const [first, second] = await Promise.all([
      claimOutboxItems(handle.worker, "worker-a", 6),
      claimOutboxItems(handle.worker, "worker-b", 6),
    ]);
    expect(first).toHaveLength(6);
    expect(second).toHaveLength(6);
    const ids = [...first, ...second].map((item) => item.id);
    expect(new Set(ids).size).toBe(12);

    const item = first[0];
    if (!item) throw new Error("claimed fixture missing");
    expect(await markOutboxDelivered(handle.worker, item.id, "worker-b")).toBe(false);
    expect(await markOutboxDelivered(handle.worker, item.id, "worker-a")).toBe(true);
    const [stored] = await handle.owner.unsafe<{ status: string; deliveredAt: string | null }[]>(
      `SELECT status, "deliveredAt" FROM outbox WHERE id = $1`,
      [item.id],
    );
    expect(stored).toMatchObject({ status: "delivered" });
    expect(stored?.deliveredAt).toBeTruthy();
  });

  it("recovers an expired lease and applies bounded retry/dead-letter state", async () => {
    await receiveWithOutbox("lease-recovery");
    const [row] = await handle.owner.unsafe<{ id: string }[]>(
      `UPDATE outbox
       SET status = 'processing', "lockedAt" = now() - interval '6 minutes',
           "lockedBy" = 'crashed-worker', attempt_count = max_attempts - 1
       RETURNING id`,
    );
    if (!row) throw new Error("outbox fixture missing");

    const claimed = await claimOutboxItems(handle.worker, "recovery-worker", 1);
    expect(claimed[0]).toMatchObject({ id: row.id, lockedBy: "recovery-worker" });
    expect(await markOutboxFailed(handle.worker, row.id, "recovery-worker", "safe failure")).toBe(true);
    const [stored] = await handle.owner.unsafe<{ status: string; nextAttemptAt: string | null }[]>(
      `SELECT status, "nextAttemptAt" FROM outbox WHERE id = $1`,
      [row.id],
    );
    expect(stored).toEqual({ status: "dead_letter", nextAttemptAt: null });
  });

  it("keeps raw event fields append-only and exposes failed events only in scope", async () => {
    const received = await receive("failed-visible");
    await withIntegrationContext(
      handle.app,
      { integrationId, organizationId, clientId },
      async (tx) => {
        const updated = await markEventFailed(
          tx as unknown as postgres.Sql,
          received.businessEvent.id,
          integrationId,
          "classified failure",
        );
        expect(updated).toBe(true);
      },
    );

    await expect(
      handle.app.unsafe(
        `UPDATE business_events SET raw_json = '{"tampered":true}'::jsonb WHERE id = $1`,
        [received.businessEvent.id],
      ),
    ).rejects.toThrow();
    await expect(
      handle.app.unsafe(`DELETE FROM business_events WHERE id = $1`, [received.businessEvent.id]),
    ).rejects.toThrow();

    const failed = await withTenantContext(handle.app, actor, async (tx) =>
      getFailedEvents(tx as unknown as postgres.Sql, organizationId),
    );
    expect(failed.map((event) => event.id)).toContain(received.businessEvent.id);
  });

  it("does not overwrite a projected terminal event with a late failure", async () => {
    const received = await receive("terminal-event-status");
    await withIntegrationContext(
      handle.app,
      { integrationId, organizationId, clientId },
      async (tx) => {
        const sql = tx as unknown as postgres.Sql;
        expect(
          await markEventProjected(sql, received.businessEvent.id, integrationId),
        ).toBe(true);
        expect(
          await markEventFailed(
            sql,
            received.businessEvent.id,
            integrationId,
            "late worker failure",
          ),
        ).toBe(false);
      },
    );

    const [stored] = await handle.owner.unsafe<{ status: string; error: string | null }[]>(
      `SELECT status, error_message AS error FROM business_events WHERE id = $1`,
      [received.businessEvent.id],
    );
    expect(stored).toEqual({ status: "projected", error: null });
  });
});
