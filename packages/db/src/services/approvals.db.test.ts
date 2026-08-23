import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type postgres from "postgres";
import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
} from "../test/fixtures.js";
import { withTenantContext } from "../tenancy/context.js";
import { createIntegration } from "./integrations.js";
import {
  createApproval,
  decideApproval,
  createApprovalToken,
  lookupApprovalByToken,
  consumeTokenAndDecide,
  revokeApprovalToken,
  getApprovalById,
  listApprovalsForTenant,
  type CreateApprovalParams,
} from "./approvals.js";

function sql(tx: unknown): postgres.Sql {
  return tx as postgres.Sql;
}

describe("Phase 5: Approval Services (db)", () => {
  let handle: FixtureHandle;
  let orgId: string;
  let clientId: string;
  let actor: { userId: string; organizationId: string; role: "agency_owner" };
  let integrationId: string;
  let otherOrgId: string;
  let otherClientId: string;
  let otherActor: { userId: string; organizationId: string; role: "agency_owner" };
  let otherIntegrationId: string;

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
    const seeded = await seedTenancyFixture(handle);
    orgId = seeded.orgA.id;
    clientId = seeded.clients.a1.id;
    actor = {
      userId: seeded.users.ownerA.id,
      organizationId: orgId,
      role: "agency_owner",
    };
    otherOrgId = seeded.orgB.id;
    otherClientId = seeded.clients.b1.id;
    otherActor = {
      userId: seeded.users.ownerB.id,
      organizationId: otherOrgId,
      role: "agency_owner",
    };

    const created = await withTenantContext(handle.app, actor, async (tx) =>
      createIntegration(sql(tx), {
        organizationId: actor.organizationId,
        clientId,
        name: "test-integration",
      }),
    );
    integrationId = created.integration.id;

    const otherCreated = await withTenantContext(handle.app, otherActor, async (tx) =>
      createIntegration(sql(tx), {
        organizationId: otherOrgId,
        clientId: otherClientId,
        name: "other-tenant-integration",
      }),
    );
    otherIntegrationId = otherCreated.integration.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  const buildParams = (corr?: string): CreateApprovalParams => ({
    organizationId: orgId,
    clientId,
    integrationId,
    snapshot: {
      contactName: "Test Contact",
      company: "Test Corp",
      message: "Interested in services",
      score: 75,
      qualificationSummary: "Qualified lead",
    },
    requestedBy: actor.userId,
    correlationId: corr ?? `corr-${Math.random().toString(36).slice(2, 10)}`,
    requestVersion: "1",
  });

  describe("createApproval", () => {
    it("creates a new approval and immutable history entry", async () => {
      const result = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), buildParams()),
      );
      expect(result.id).toBeTruthy();
      expect(result.status).toBe("pending");
      expect(result.version).toBe(1);
      expect(result.isNew).toBe(true);
      const [counts] = await handle.owner.unsafe<{ history: string; deliveries: string }[]>(
        `SELECT
           (SELECT count(*) FROM approval_history WHERE "approvalId" = $1) AS history,
           (SELECT count(*) FROM approval_deliveries WHERE "approvalId" = $1) AS deliveries`,
        [result.id],
      );
      expect(counts).toEqual({ history: '1', deliveries: '0' });
    });

    it("is idempotent with same correlation", async () => {
      const params = buildParams("corr-same");
      const first = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), params),
      );
      const second = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), params),
      );
      expect(second.id).toBe(first.id);
      expect(second.isNew).toBe(false);
    });

    it("can be read back", async () => {
      const params = buildParams("corr-readback");
      const created = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), params),
      );
      const read = await withTenantContext(handle.app, actor, async (tx) =>
        getApprovalById(sql(tx), created.id, params.organizationId, params.clientId),
      );
      expect(read).not.toBeNull();
      expect(read!.id).toBe(created.id);
    });
  });

  describe("listApprovalsForTenant", () => {
    it("paginates deterministically and preserves tenant isolation", async () => {
      const first = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), buildParams("corr-list-first")),
      );
      const second = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), buildParams("corr-list-second")),
      );

      const foreign = await withTenantContext(handle.app, otherActor, async (tx) =>
        createApproval(sql(tx), {
          ...buildParams("corr-list-foreign"),
          organizationId: otherOrgId,
          clientId: otherClientId,
          integrationId: otherIntegrationId,
          requestedBy: otherActor.userId,
        }),
      );

      const pageOne = await withTenantContext(handle.app, actor, async (tx) =>
        listApprovalsForTenant(sql(tx), {
          organizationId: orgId,
          clientId,
          limit: 1,
        }),
      );
      expect(pageOne.items).toHaveLength(1);
      expect(pageOne.nextCursor).toBeTruthy();

      const pageTwo = await withTenantContext(handle.app, actor, async (tx) =>
        listApprovalsForTenant(sql(tx), {
          organizationId: orgId,
          clientId,
          cursor: pageOne.nextCursor,
          limit: 1,
        }),
      );
      expect(pageTwo.items).toHaveLength(1);
      expect(pageTwo.nextCursor).toBeNull();
      expect(new Set([...pageOne.items, ...pageTwo.items].map((item) => item.id))).toEqual(
        new Set([first.id, second.id]),
      );

      const crossTenantAttempt = await withTenantContext(handle.app, actor, async (tx) =>
        listApprovalsForTenant(sql(tx), {
          organizationId: otherOrgId,
          clientId: otherClientId,
          limit: 10,
        }),
      );
      expect(crossTenantAttempt.items).toEqual([]);

      const foreignVisibleToOwner = await withTenantContext(handle.app, otherActor, async (tx) =>
        listApprovalsForTenant(sql(tx), {
          organizationId: otherOrgId,
          clientId: otherClientId,
          limit: 10,
        }),
      );
      expect(foreignVisibleToOwner.items.map((item) => item.id)).toEqual([foreign.id]);
    });
  });

  describe("decideApproval", () => {
    it("rejects non-existent approval", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000001";
      await withTenantContext(handle.app, actor, async (tx) => {
        const result = await decideApproval(sql(tx), {
          approvalId: fakeId,
          organizationId: orgId,
          clientId,
          decision: "approved",
          decidedBy: actor.userId,
        });
        expect(result.decided).toBe(false);
      });
    });

    it("approves a pending approval", async () => {
      const created = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), buildParams("corr-approve")),
      );
      const result = await withTenantContext(handle.app, actor, async (tx) =>
        decideApproval(sql(tx), {
          approvalId: created.id,
          organizationId: orgId,
          clientId,
          decision: "approved",
          decidedBy: actor.userId,
        }),
      );
      expect(result.decided).toBe(true);
      expect(result.status).toBe("approved");
      expect(result.version).toBeGreaterThan(1);
    });

    it("rejects already decided approval (409)", async () => {
      const created = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), buildParams("corr-decided")),
      );
      await withTenantContext(handle.app, actor, async (tx) =>
        decideApproval(sql(tx), {
          approvalId: created.id,
          organizationId: orgId,
          clientId,
          decision: "approved",
          decidedBy: actor.userId,
        }),
      );
      const second = await withTenantContext(handle.app, actor, async (tx) =>
        decideApproval(sql(tx), {
          approvalId: created.id,
          organizationId: orgId,
          clientId,
          decision: "rejected",
          decidedBy: actor.userId,
          expectedVersion: created.version,
        }),
      );
      expect(second.decided).toBe(false);
      expect(second.status).toBe("approved");
    });

    it("version check rejects wrong expected version", async () => {
      const created = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), buildParams("corr-version")),
      );
      const result = await withTenantContext(handle.app, actor, async (tx) =>
        decideApproval(sql(tx), {
          approvalId: created.id,
          organizationId: orgId,
          clientId,
          decision: "approved",
          decidedBy: actor.userId,
          expectedVersion: 999,
        }),
      );
      expect(result.decided).toBe(false);
    });
  });

  describe("approval tokens", () => {
    it("creates and looks up token", async () => {
      const created = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), buildParams("corr-token")),
      );
      const tokenResult = await withTenantContext(handle.app, actor, async (tx) =>
        createApprovalToken(sql(tx), {
          approvalId: created.id,
          organizationId: orgId,
          clientId,
          ttlSeconds: 3600,
        }),
      );
      expect(tokenResult.token).toBeTruthy();

      const lookup = await lookupApprovalByToken(sql(handle.app), tokenResult.token);
      expect(lookup.tokenStatus).toBe("valid");
    });

    it("returns not_found for invalid token", async () => {
      const lookup = await lookupApprovalByToken(
        sql(handle.app),
        "this-is-not-a-valid-token-at-all-very-long-invalid-token",
      );
      expect(lookup.tokenStatus).toBe("not_found");
    });

    it("consumes token and decides approval", async () => {
      const created = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), buildParams("corr-consume")),
      );
      const tokenResult = await withTenantContext(handle.app, actor, async (tx) =>
        createApprovalToken(sql(tx), {
          approvalId: created.id,
          organizationId: orgId,
          clientId,
          ttlSeconds: 3600,
        }),
      );

      const decide = await consumeTokenAndDecide(
        sql(handle.app),
        tokenResult.token,
        "approved",
        "public_user",
      );
      expect(decide.decided).toBe(true);
      expect(decide.status).toBe("approved");
    });

    it("revokes a token", async () => {
      const created = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), buildParams("corr-revoke")),
      );
      const tokenResult = await withTenantContext(handle.app, actor, async (tx) =>
        createApprovalToken(sql(tx), {
          approvalId: created.id,
          organizationId: orgId,
          clientId,
        }),
      );
      const revoked = await withTenantContext(handle.app, actor, async (tx) =>
        revokeApprovalToken(sql(tx), {
          tokenPlaintext: tokenResult.token,
          organizationId: orgId,
          clientId,
        }),
      );
      expect(revoked).toBe(true);
    });

    it("token hash is not plaintext in database", async () => {
      const created = await withTenantContext(handle.app, actor, async (tx) =>
        createApproval(sql(tx), buildParams("corr-hash")),
      );
      const tokenResult = await withTenantContext(handle.app, actor, async (tx) =>
        createApprovalToken(sql(tx), {
          approvalId: created.id,
          organizationId: orgId,
          clientId,
        }),
      );

      const dbRows = await handle.owner.unsafe(
        `SELECT token_hash FROM approval_tokens
         WHERE "approvalId" = $1::uuid
         ORDER BY "createdAt" DESC LIMIT 1`,
        [created.id],
      );
      expect(dbRows.length).toBe(1);
      const storedHash = (dbRows[0] as Record<string, unknown>).token_hash as string;
      expect(storedHash).not.toBe(tokenResult.token);
      expect(storedHash.length).toBe(64);
    });
  });
});
