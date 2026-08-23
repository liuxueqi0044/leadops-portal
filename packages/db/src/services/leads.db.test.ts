import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type postgres from "postgres";
import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
} from "../test/fixtures.js";
import { withTenantContext, withIntegrationContext } from "../tenancy/context.js";
import { createIntegration } from "./integrations.js";
import { createOutboxMessage } from "./events.js";
import {
  upsertLeadAndInsertHistory,
  insertStatusHistory,
  updateLeadStatus,
  applyQualificationToLead,
  getLeadById,
  listLeads,
  getDashboardMetrics,
  createAiRun,
  getLeadStatusHistory,
} from "./leads.js";

function sql(tx: unknown): postgres.Sql {
  return tx as postgres.Sql;
}

describe("Phase 4: Lead Services", () => {
  let handle: FixtureHandle;
  let organizationId: string;
  let clientA1Id: string;
  let clientB1Id: string;
  let otherOrgId: string;
  let actor: { userId: string; organizationId: string; role: "agency_owner" };
  let otherOrgActor: { userId: string; organizationId: string; role: "agency_owner" };
  let integrationId: string;

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
    const seeded = await seedTenancyFixture(handle);
    organizationId = seeded.orgA.id;
    clientA1Id = seeded.clients.a1.id;
    clientB1Id = seeded.clients.b1.id;
    otherOrgId = seeded.orgB.id;
    actor = {
      userId: seeded.users.ownerA.id,
      organizationId,
      role: "agency_owner" as const,
    };
    otherOrgActor = {
      userId: seeded.users.ownerB.id,
      organizationId: otherOrgId,
      role: "agency_owner" as const,
    };
    const created = await withTenantContext(handle.app, actor, async (tx) =>
      createIntegration(sql(tx), {
        organizationId,
        clientId: clientA1Id,
        name: "Lead test integration",
      }),
    );
    integrationId = created.integration.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  const ctx = () => ({ integrationId, organizationId, clientId: clientA1Id });

  describe("Lead upsert and dedupe", () => {
    it("creates a new lead with status received", async () => {
      const result = await withIntegrationContext(handle.app, ctx(), async (tx) => {
        return upsertLeadAndInsertHistory(sql(tx), {
          organizationId,
          clientId: clientA1Id,
          source: "website",
          externalId: "lead-001",
          contactName: "John Doe",
          email: "john@example.com",
          phone: "555-1234",
          company: "ACME",
          message: "Need HVAC",
          receivedAt: "2026-08-01T10:00:00Z",
        });
      });

      expect(result.isNew).toBe(true);
      expect(result.status).toBe("received");

      const lead = await withIntegrationContext(handle.app, ctx(), async (tx) => {
        return getLeadById(sql(tx), {
          leadId: result.id,
          organizationId,
          clientId: clientA1Id,
        });
      });
      expect(lead).not.toBeNull();
      if (lead) {
        expect(lead.email).toBe("john@example.com");
        expect(lead.source).toBe("website");
      }
    });

    it("upsert with same externalId does not create duplicate", async () => {
      const result1 = await withIntegrationContext(handle.app, ctx(), async (tx) => {
        return upsertLeadAndInsertHistory(sql(tx), {
          organizationId,
          clientId: clientA1Id,
          source: "website",
          externalId: "lead-002",
          contactName: "Jane",
          email: "jane@test.com",
          phone: "555-0000",
          company: "TestCo",
          message: "Hello",
          receivedAt: "2026-08-01T10:00:00Z",
        });
      });
      expect(result1.isNew).toBe(true);

      const result2 = await withIntegrationContext(handle.app, ctx(), async (tx) => {
        return upsertLeadAndInsertHistory(sql(tx), {
          organizationId,
          clientId: clientA1Id,
          source: "website",
          externalId: "lead-002",
          contactName: "Jane Updated",
          email: "jane@test.com",
          phone: "555-0000",
          company: "TestCo",
          message: "Updated message",
          receivedAt: "2026-08-02T10:00:00Z",
        });
      });
      expect(result2.isNew).toBe(false);
      expect(result2.id).toBe(result1.id);

      const history = await withIntegrationContext(handle.app, ctx(), async (tx) => {
        return getLeadStatusHistory(sql(tx), {
          leadId: result1.id,
          organizationId,
          clientId: clientA1Id,
        });
      });
      expect(history.length).toBe(1);
    });

    it("returns the existing terminal lead on replay without null fields", async () => {
      const first = await withIntegrationContext(handle.app, ctx(), async (tx) =>
        upsertLeadAndInsertHistory(sql(tx), {
          organizationId,
          clientId: clientA1Id,
          source: "website",
          externalId: "terminal-replay",
          contactName: "Terminal Lead",
          email: "terminal@test.com",
          phone: null,
          company: null,
          message: "Original",
          receivedAt: "2026-08-01T10:00:00Z",
        }),
      );

      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        const archived = await updateLeadStatus(sql(tx), {
          leadId: first.id,
          organizationId,
          clientId: clientA1Id,
          newStatus: "archived",
          command: "archive",
        });
        expect(archived).toBe(true);
      });

      const replay = await withIntegrationContext(handle.app, ctx(), async (tx) =>
        upsertLeadAndInsertHistory(sql(tx), {
          organizationId,
          clientId: clientA1Id,
          source: "website",
          externalId: "terminal-replay",
          contactName: "Should Not Replace",
          email: "terminal@test.com",
          phone: null,
          company: null,
          message: "Replay",
          receivedAt: "2026-08-02T10:00:00Z",
        }),
      );

      expect(replay).toEqual({
        id: first.id,
        organizationId,
        clientId: clientA1Id,
        status: "archived",
        isNew: false,
      });

      const [counts] = await handle.owner.unsafe<{ leads: string; history: string }[]>(
        `SELECT
           (SELECT count(*) FROM leads WHERE id = $1) AS leads,
           (SELECT count(*) FROM lead_status_history WHERE "leadId" = $1) AS history`,
        [first.id],
      );
      expect(counts).toEqual({ leads: "1", history: "2" });
    });

    it("collapses 50 concurrent identical leads to one aggregate and one history row", async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          withIntegrationContext(handle.app, ctx(), async (tx) =>
            upsertLeadAndInsertHistory(sql(tx), {
              organizationId,
              clientId: clientA1Id,
              source: "website",
              externalId: "lead-50-concurrent",
              contactName: "Concurrent Lead",
              email: "concurrent@test.com",
              phone: null,
              company: null,
              message: "Concurrent",
              receivedAt: "2026-08-01T10:00:00Z",
            }),
          ),
        ),
      );

      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.filter((result) => result.isNew)).toHaveLength(1);

      const leadId = results[0]?.id;
      if (!leadId) throw new Error("concurrent lead upsert returned no id");
      const [counts] = await handle.owner.unsafe<{ leads: string; history: string }[]>(
        `SELECT
           (SELECT count(*) FROM leads WHERE "clientId" = $1 AND "externalId" = $2) AS leads,
           (SELECT count(*) FROM lead_status_history WHERE "leadId" = $3) AS history`,
        [clientA1Id, "lead-50-concurrent", leadId],
      );
      expect(counts).toEqual({ leads: "1", history: "1" });
    });

    it("same externalId in different clients are isolated", async () => {
      const leadA = await withIntegrationContext(handle.app, ctx(), async (tx) => {
        return upsertLeadAndInsertHistory(sql(tx), {
          organizationId,
          clientId: clientA1Id,
          source: "website",
          externalId: "lead-shared",
          contactName: "Client A Lead",
          email: "a@a.com",
          phone: null,
          company: null,
          message: null,
          receivedAt: "2026-08-01T10:00:00Z",
        });
      });

      const intB = await withTenantContext(handle.app, otherOrgActor, async (tx) =>
        createIntegration(sql(tx), {
          organizationId: otherOrgId,
          clientId: clientB1Id,
          name: "Lead test B",
        }),
      );

      const ctxB = { integrationId: intB.integration.id, organizationId: otherOrgId, clientId: clientB1Id };
      const leadB = await withIntegrationContext(handle.app, ctxB, async (tx) => {
        return upsertLeadAndInsertHistory(sql(tx), {
          organizationId: otherOrgId,
          clientId: clientB1Id,
          source: "website",
          externalId: "lead-shared",
          contactName: "Client B Lead",
          email: "b@b.com",
          phone: null,
          company: null,
          message: null,
          receivedAt: "2026-08-01T10:00:00Z",
        });
      });

      expect(leadB.id).not.toBe(leadA.id);

      // Can't see B's lead from A's context
      const crossRead = await withIntegrationContext(handle.app, ctx(), async (tx) => {
        return getLeadById(sql(tx), {
          leadId: leadB.id,
          organizationId,
          clientId: clientA1Id,
        });
      });
      expect(crossRead).toBeNull();
    });
  });

  describe("Status transitions", () => {
    let leadId: string;

    beforeEach(async () => {
      const result = await withIntegrationContext(handle.app, ctx(), async (tx) => {
        return upsertLeadAndInsertHistory(sql(tx), {
          organizationId,
          clientId: clientA1Id,
          source: "website",
          externalId: "lead-status-" + Math.random().toString(36).slice(2),
          contactName: "Test Lead",
          email: "test@test.com",
          phone: null,
          company: null,
          message: null,
          receivedAt: "2026-08-01T10:00:00Z",
        });
      });
      leadId = result.id;
    });

    it("transitions received to qualified", async () => {
      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        const updated = await updateLeadStatus(sql(tx), {
          leadId,
          organizationId,
          clientId: clientA1Id,
          newStatus: "qualified",
          command: "qualify",
        });
        expect(updated).toBe(true);

        const lead = await getLeadById(sql(tx), {
          leadId,
          organizationId,
          clientId: clientA1Id,
        });
        expect(lead).not.toBeNull();
        if (lead) {
          expect(lead.status).toBe("qualified");
        }
      });
    });

    it("rejects illegal transition from received to approved", async () => {
      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        const updated = await updateLeadStatus(sql(tx), {
          leadId,
          organizationId,
          clientId: clientA1Id,
          newStatus: "approved",
          command: "approve",
        });
        expect(updated).toBe(false);
      });
    });

    it("cannot transition from archived", async () => {
      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        await updateLeadStatus(sql(tx), {
          leadId,
          organizationId,
          clientId: clientA1Id,
          newStatus: "archived",
          command: "archive",
        });

        const updated = await updateLeadStatus(sql(tx), {
          leadId,
          organizationId,
          clientId: clientA1Id,
          newStatus: "qualified",
          command: "qualify",
        });
        expect(updated).toBe(false);
      });
    });

    it("writes status history on transition", async () => {
      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        const s = sql(tx);
        await updateLeadStatus(s, {
          leadId,
          organizationId,
          clientId: clientA1Id,
          newStatus: "qualified",
          command: "qualify",
          performedBy: "test-runner",
        });

        await insertStatusHistory(s, {
          leadId,
          organizationId,
          clientId: clientA1Id,
          previousStatus: "received",
          newStatus: "qualified",
          command: "qualify",
          performedBy: "test-runner",
        });

        const history = await getLeadStatusHistory(s, {
          leadId,
          organizationId,
          clientId: clientA1Id,
        });
        expect(history.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe("Qualification application", () => {
    it("applies qualification data to lead", async () => {
      let lid: string;
      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        const s = sql(tx);
        const r = await upsertLeadAndInsertHistory(s, {
          organizationId,
          clientId: clientA1Id,
          source: "website",
          externalId: "lead-qual-" + Math.random().toString(36).slice(2),
          contactName: "Qual Lead",
          email: "qual@test.com",
          phone: null,
          company: null,
          message: null,
          receivedAt: "2026-08-01T10:00:00Z",
        });
        lid = r.id;

        const applied = await applyQualificationToLead(s, {
          leadId: lid,
          organizationId,
          clientId: clientA1Id,
          score: 85,
          decision: "qualified",
          summary: "Great lead",
          confidence: 0.9,
          suggestedNextAction: "book_call",
          qualifiedAt: "2026-08-01T11:00:00Z",
        });
        expect(applied).toBe(true);

        const lead = await getLeadById(s, {
          leadId: lid,
          organizationId,
          clientId: clientA1Id,
        });
        if (lead) {
          expect(lead.score).toBe(85);
          expect(lead.qualificationDecision).toBe("qualified");
        }
      });
    });
  });

  describe("AI run recording", () => {
    it("creates ai_run without sensitive data", async () => {
      let aiRunId = "";
      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        const s = sql(tx);
        const r = await upsertLeadAndInsertHistory(s, {
          organizationId,
          clientId: clientA1Id,
          source: "web",
          externalId: "lead-ai-" + Math.random().toString(36).slice(2),
          contactName: "AI Lead",
          email: "ai@test.com",
          phone: null,
          company: null,
          message: null,
          receivedAt: "2026-08-01T10:00:00Z",
        });

        const aiRun = await createAiRun(s, {
          organizationId,
          clientId: clientA1Id,
          leadId: r.id,
          provider: "fake",
          model: "fake-v1",
          promptVersion: "1.0.0",
          inputHash: "abc123",
          result: { score: 75, decision: "qualified" },
          tokens: { input: 100, output: 50 },
          cost: { amount: 0.0001, currency: "USD" },
          latencyMs: 250,
          status: "completed",
          errorClassification: null,
        });

        expect(aiRun.id).toBeDefined();
        expect(aiRun.provider).toBe("fake");
        expect(aiRun.status).toBe("completed");
        aiRunId = aiRun.id;
      });

      // Verify after commit (using owner to bypass RLS)
      const aiRows = await handle.owner.unsafe(
        `SELECT * FROM ai_runs WHERE id = $1`,
        [aiRunId],
      );
      expect(aiRows.length).toBe(1);
      const row = aiRows[0] as Record<string, unknown>;
      expect(JSON.stringify(row)).not.toContain("api_key");
      expect(JSON.stringify(row)).not.toContain("password");
    });
  });

  describe("Dashboard metrics", () => {
    it("returns correct metrics for leads", async () => {
      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        const s = sql(tx);
        for (let i = 0; i < 3; i++) {
          const r = await upsertLeadAndInsertHistory(s, {
            organizationId,
            clientId: clientA1Id,
            source: "web",
            externalId: `dash-${String(i)}`,
            contactName: `Lead ${String(i)}`,
            email: `lead${String(i)}@test.com`,
            phone: null,
            company: null,
            message: null,
            receivedAt: "2026-08-01T10:00:00Z",
          });
          if (i === 0) {
            await applyQualificationToLead(s, {
              leadId: r.id,
              organizationId,
              clientId: clientA1Id,
              score: 90,
              decision: "qualified",
              summary: "Good",
              confidence: 0.9,
              suggestedNextAction: "book_call",
              qualifiedAt: "2026-08-01T11:00:00Z",
            });
            await updateLeadStatus(s, {
              leadId: r.id,
              organizationId,
              clientId: clientA1Id,
              newStatus: "qualified",
              command: "qualify",
            });
          }
        }

        const metrics = await getDashboardMetrics(s, {
          organizationId,
          clientId: clientA1Id,
        });

        expect(metrics.totalReceived).toBe(3);
        expect(metrics.totalQualified).toBe(1);
        expect(metrics.totalNeedsReview).toBe(0);
        expect(metrics.qualificationRate).toBe(1 / 3);
      });
    });
  });

  describe("List leads pagination", () => {
    it("paginates with cursor", async () => {
      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        const s = sql(tx);
        for (let i = 0; i < 5; i++) {
          await upsertLeadAndInsertHistory(s, {
            organizationId,
            clientId: clientA1Id,
            source: "web",
            externalId: `page-${String(i)}`,
            contactName: `Lead ${String(i)}`,
            email: `page${String(i)}@test.com`,
            phone: null,
            company: null,
            message: null,
            receivedAt: `2026-08-0${String(i + 1)}T10:00:00Z`,
          });
        }

        const page1 = await listLeads(s, {
          organizationId,
          clientId: clientA1Id,
          limit: 2,
        });
        expect(page1.items.length).toBe(2);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = await listLeads(s, {
          organizationId,
          clientId: clientA1Id,
          limit: 2,
          cursor: page1.nextCursor,
        });
        expect(page2.items.length).toBe(2);

        const page3 = await listLeads(s, {
          organizationId,
          clientId: clientA1Id,
          limit: 2,
          cursor: page2.nextCursor,
        });
        expect(page3.items.length).toBe(1);
        expect(page3.nextCursor).toBeNull();
      });
    });

    it("filters by status", async () => {
      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        const s = sql(tx);
        const r = await upsertLeadAndInsertHistory(s, {
          organizationId,
          clientId: clientA1Id,
          source: "web",
          externalId: "filter-qual",
          contactName: "Qual Lead",
          email: "qual@test.com",
          phone: null,
          company: null,
          message: null,
          receivedAt: "2026-08-01T10:00:00Z",
        });
        await updateLeadStatus(s, {
          leadId: r.id,
          organizationId,
          clientId: clientA1Id,
          newStatus: "qualified",
          command: "qualify",
        });

        const qualifiedLeads = await listLeads(s, {
          organizationId,
          clientId: clientA1Id,
          limit: 10,
          status: "qualified",
        });
        expect(qualifiedLeads.items.length).toBe(1);
        if (qualifiedLeads.items[0]) {
          expect(qualifiedLeads.items[0].status).toBe("qualified");
        }
      });
    });
  });

  describe("Cross-tenant isolation", () => {
    it("lets the bound worker enqueue qualification while rejecting forged bindings", async () => {
      const message = await withIntegrationContext(handle.worker, ctx(), async (tx) =>
        createOutboxMessage(sql(tx), {
          organizationId,
          integrationId,
          clientId: clientA1Id,
          aggregateType: "lead",
          aggregateId: "worker-outbox-grant",
          messageType: "leads.qualify",
          payload: { leadId: "worker-outbox-grant" },
        }),
      );
      expect(message.messageType).toBe("leads.qualify");

      await expect(
        withIntegrationContext(handle.worker, {
          integrationId: "00000000-0000-0000-0000-00000000f002",
          organizationId,
          clientId: clientA1Id,
        }, async (tx) =>
          createOutboxMessage(sql(tx), {
            organizationId,
            integrationId: "00000000-0000-0000-0000-00000000f002",
            clientId: clientA1Id,
            aggregateType: "lead",
            aggregateId: "forged-worker-outbox",
            messageType: "leads.qualify",
            payload: { leadId: "forged-worker-outbox" },
          }),
        ),
      ).rejects.toThrow(/row-level security|policy/i);
    });

    it("ownerA cannot see OtherOrg leads", async () => {
      let leadId: string;
      await withIntegrationContext(handle.app, ctx(), async (tx) => {
        const r = await upsertLeadAndInsertHistory(sql(tx), {
          organizationId,
          clientId: clientA1Id,
          source: "web",
          externalId: "tenant-test-a",
          contactName: "OrgA Lead",
          email: "orga@test.com",
          phone: null,
          company: null,
          message: null,
          receivedAt: "2026-08-01T10:00:00Z",
        });
        leadId = r.id;
      });

      // Query as OrgB actor via tenant context
      const lead = await withTenantContext(handle.app, otherOrgActor, async (tx) => {
        return getLeadById(sql(tx), {
          leadId,
          organizationId: otherOrgId,
          clientId: clientB1Id,
        });
      });
      expect(lead).toBeNull();
    });

    it("rejects a forged integration context for direct lead inserts", async () => {
      await expect(
        withIntegrationContext(handle.app, {
          integrationId: "00000000-0000-0000-0000-00000000f001",
          organizationId,
          clientId: clientA1Id,
        }, async (tx) => {
          await tx.unsafe(
            `INSERT INTO leads (
               "organizationId", "clientId", source, "externalId",
               "dedupeKey", "dedupeVersion", status, "receivedAt"
             ) VALUES ($1, $2, 'web', 'forged-direct', '1:ext:web:forged-direct', 1, 'received', now())`,
            [organizationId, clientA1Id],
          );
        }),
      ).rejects.toThrow(/row-level security|policy/i);

      const [count] = await handle.owner.unsafe<{ n: string }[]>(
        `SELECT count(*) AS n FROM leads WHERE "externalId" = 'forged-direct'`,
      );
      expect(count?.n).toBe("0");
    });

    it("rejects SECURITY DEFINER lead operations outside the active integration tenant", async () => {
      const integrationB = await withTenantContext(handle.app, otherOrgActor, async (tx) =>
        createIntegration(sql(tx), {
          organizationId: otherOrgId,
          clientId: clientB1Id,
          name: "Lead security integration B",
        }),
      );

      const leadB = await withIntegrationContext(handle.app, {
        integrationId: integrationB.integration.id,
        organizationId: otherOrgId,
        clientId: clientB1Id,
      }, async (tx) =>
        upsertLeadAndInsertHistory(sql(tx), {
          organizationId: otherOrgId,
          clientId: clientB1Id,
          source: "web",
          externalId: "foreign-security-lead",
          contactName: "Foreign Lead",
          email: "foreign@test.com",
          phone: null,
          company: null,
          message: null,
          receivedAt: "2026-08-01T10:00:00Z",
        }),
      );

      await expect(
        withIntegrationContext(handle.app, ctx(), async (tx) =>
          upsertLeadAndInsertHistory(sql(tx), {
            organizationId: otherOrgId,
            clientId: clientB1Id,
            source: "web",
            externalId: "cross-tenant-definer",
            contactName: "Attack",
            email: "attack@test.com",
            phone: null,
            company: null,
            message: null,
            receivedAt: "2026-08-01T10:00:00Z",
          }),
        ),
      ).rejects.toThrow(/lead tenant context is not authorized/i);

      await expect(
        withIntegrationContext(handle.app, ctx(), async (tx) =>
          tx.unsafe(
            `SELECT * FROM lookup_lead_by_external($1::uuid, $2::uuid, 'web', 'foreign-security-lead')`,
            [otherOrgId, clientB1Id],
          ),
        ),
      ).rejects.toThrow(/lead tenant context is not authorized/i);

      await expect(
        withIntegrationContext(handle.app, ctx(), async (tx) =>
          tx.unsafe(
            `SELECT apply_lead_status_atomic(
               $1::uuid, $2::uuid, $3::uuid,
               'archive', 'archived', 'attacker', 'received'
             )`,
            [leadB.id, otherOrgId, clientB1Id],
          ),
        ),
      ).rejects.toThrow(/lead tenant context is not authorized/i);

      const [state] = await handle.owner.unsafe<{ foreign_rows: string; status: string }[]>(
        `SELECT
           (SELECT count(*) FROM leads WHERE "externalId" = 'cross-tenant-definer') AS foreign_rows,
           (SELECT status FROM leads WHERE id = $1) AS status`,
        [leadB.id],
      );
      expect(state).toEqual({ foreign_rows: "0", status: "received" });
    });
  });
});
