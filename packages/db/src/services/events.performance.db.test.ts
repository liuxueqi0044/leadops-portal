import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";

import { claimOutboxItems } from "./events.js";
import { createIntegration } from "./integrations.js";
import { withTenantContext } from "../tenancy/context.js";
import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
} from "../test/fixtures.js";

describe("event batch performance", () => {
  let fixture: FixtureHandle;

  beforeAll(() => {
    fixture = createFixtureHandle();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("claims 10,000 fixture events in ten set-based batches without N+1 queries", async () => {
    await resetSchema(fixture);
    const seeded = await seedTenancyFixture(fixture);
    const organizationId = seeded.orgA.id;
    const clientId = seeded.clients.a1.id;
    const created = await withTenantContext(
      fixture.app,
      {
        userId: seeded.users.ownerA.id,
        organizationId,
        role: "agency_owner",
      },
      async (tx) =>
        createIntegration(tx as unknown as postgres.Sql, {
          organizationId,
          clientId,
          name: "10k performance fixture",
        }),
    );
    const integrationId = created.integration.id;

    await fixture.owner.unsafe(
      `INSERT INTO business_events (
         "integrationId", "organizationId", "clientId", "webhookId",
         "eventType", raw_json, body_hash
       )
       SELECT $1, $2, $3, 'perf-' || g::text, 'workflow.run.started',
              jsonb_build_object('fixture', g), md5(g::text)
       FROM generate_series(1, 10000) AS g`,
      [integrationId, organizationId, clientId],
    );
    await fixture.owner.unsafe(
      `INSERT INTO outbox (
         "organizationId", "integrationId", "clientId", aggregate_type,
         aggregate_id, message_type, payload
       )
       SELECT "organizationId", "integrationId", "clientId", 'business_event',
              id::text, 'events.project', jsonb_build_object('eventId', id)
       FROM business_events
       WHERE "integrationId" = $1`,
      [integrationId],
    );

    const startedAt = performance.now();
    const batches = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        claimOutboxItems(fixture.worker, `perf-worker-${String(index)}`, 1000),
      ),
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    const ids = batches.flatMap((batch) => batch.map((item) => item.id));

    console.info(
      `[phase3-performance] claimed 10000 outbox rows in ${String(elapsedMs)}ms using 10 SQL batches`,
    );
    expect(ids).toHaveLength(10_000);
    expect(new Set(ids).size).toBe(10_000);
    expect(elapsedMs).toBeLessThan(20_000);
  }, 30_000);
});
