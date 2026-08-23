import { describe, expect, it } from "vitest";
import {
  JOB_DEFINITIONS,
  getJob,
  isEnabled,
  getDisabledJobs,
  DISABLED_REASON,
} from "./registry.js";
import type { JobDefinition } from "./types.js";

function parseWith(def: JobDefinition | undefined, data: unknown): { success: boolean; data?: unknown; error?: { issues: unknown[] } } {
  if (!def) return { success: false, error: { issues: [{ message: "No job definition" }] } };
  return def.payloadSchema.safeParse(data);
}

describe("Job Registry", () => {
  it("contains all 8 required job names", () => {
    const names = Object.keys(JOB_DEFINITIONS);
    expect(names).toHaveLength(8);
    expect(names).toContain("events.project");
    expect(names).toContain("leads.qualify");
    expect(names).toContain("approvals.expire");
    expect(names).toContain("approvals.deliver-result");
    expect(names).toContain("emails.send");
    expect(names).toContain("incidents.open-from-failure");
    expect(names).toContain("reports.generate-weekly");
    expect(names).toContain("retention.prune-non-audit-data");
  });

  it("correctly identifies enabled and disabled jobs", () => {
    expect(isEnabled("events.project")).toBe(true);
    expect(isEnabled("leads.qualify")).toBe(true);
    expect(isEnabled("approvals.expire")).toBe(true);
    expect(isEnabled("approvals.deliver-result")).toBe(true);
    expect(isEnabled("emails.send")).toBe(true);
    expect(isEnabled("incidents.open-from-failure")).toBe(true);
    expect(isEnabled("reports.generate-weekly")).toBe(true);
    expect(isEnabled("retention.prune-non-audit-data")).toBe(true);
  });

  it("getDisabledJobs returns an empty array (all jobs enabled in Phase 6C)", () => {
    const disabled = getDisabledJobs();
    expect(disabled).toHaveLength(0);
  });

  it("disabled reason constant is updated for Phase 6C", () => {
    expect(DISABLED_REASON).toBe("disabled_pending_phase_6c");
  });

  it("getJob returns undefined for unknown job name", () => {
    expect(getJob("nonexistent.job")).toBeUndefined();
  });

  it("getJob returns definition for known job name", () => {
    const def = getJob("events.project");
    expect(def).toBeDefined();
    expect(def?.name).toBe("events.project");
    expect(def?.schemaVersion).toBe(1);
    expect(def?.tenantScope).toBe("tenant");
    expect(def?.retryLimit).toBe(10);
  });

  it("retention job is now enabled in Phase 6C", () => {
    const def = getJob("retention.prune-non-audit-data");
    expect(def?.enabled).toBe(true);
  });

  it("retention job has system scope", () => {
    const def = getJob("retention.prune-non-audit-data");
    expect(def?.tenantScope).toBe("system");
  });

  it("events.project has eventId in payload schema", () => {
    const def = getJob("events.project");
    const result = parseWith(def, {
      schemaVersion: 1,
      eventId: "00000000-0000-0000-0000-000000000001",
      eventType: "lead.received",
      integrationId: "00000000-0000-0000-0000-000000000002",
      organizationId: "00000000-0000-0000-0000-000000000003",
      clientId: "00000000-0000-0000-0000-000000000004",
    });
    expect(result.success).toBe(true);
  });

  it("events.project rejects invalid payload", () => {
    const def = getJob("events.project");
    const result = parseWith(def, {
      schemaVersion: "not-a-number",
    });
    expect(result.success).toBe(false);
  });

  it("leads.qualify has correct payload schema", () => {
    const def = getJob("leads.qualify");
    const result = parseWith(def, {
      schemaVersion: 1,
      leadId: "00000000-0000-0000-0000-000000000001",
      organizationId: "00000000-0000-0000-0000-000000000002",
      clientId: "00000000-0000-0000-0000-000000000003",
      integrationId: "00000000-0000-0000-0000-000000000004",
    });
    expect(result.success).toBe(true);
  });

  it("emails.send has correct payload schema", () => {
    const def = getJob("emails.send");
    const result = parseWith(def, {
      schemaVersion: 1,
      deliveryId: "00000000-0000-0000-0000-000000000001",
      organizationId: "00000000-0000-0000-0000-000000000002",
      clientId: "00000000-0000-0000-0000-000000000003",
      integrationId: "00000000-0000-0000-0000-000000000004",
    });
    expect(result.success).toBe(true);
  });

  it("retention.prune-non-audit-data has optional dryRun field", () => {
    const def = getJob("retention.prune-non-audit-data");
    const result1 = parseWith(def, { schemaVersion: 1 });
    expect(result1.success).toBe(true);
    const result2 = parseWith(def, { schemaVersion: 1, dryRun: true });
    expect(result2.success).toBe(true);
  });
});
