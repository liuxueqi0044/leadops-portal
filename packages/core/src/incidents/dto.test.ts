import { describe, expect, it } from "vitest";
import {
  normalizeFingerprint,
  createIncidentStateMachine,
  incidentDtoSchema,
  incidentsListQuerySchema,
  incidentCursorSchema,
  acknowledgeIncidentRequestSchema,
  resolveIncidentRequestSchema,
} from "./dto.js";

describe("normalizeFingerprint", () => {
  it("produces a lowercase pipe-delimited fingerprint", () => {
    const fp = normalizeFingerprint({
      organizationId: "ORG-123",
      clientId: "CLIENT-456",
      workflow: "worfklow-1",
      category: "retryable",
      errorName: "ECONNREFUSED",
    });
    expect(fp).toBe("org-123|client-456|worfklow-1|retryable|econnrefused");
  });

  it("uses 'unknown' for missing workflow", () => {
    const fp = normalizeFingerprint({
      organizationId: "A",
      clientId: "B",
      category: "timeout",
      errorName: "TimeoutError",
    });
    expect(fp).toBe("a|b|unknown|timeout|timeouterror");
  });

  it("replaces pipe characters in segments with underscore", () => {
    const fp = normalizeFingerprint({
      organizationId: "org|a",
      clientId: "client|b",
      workflow: "wf|c",
      category: "cat|d",
      errorName: "err|e",
    });
    expect(fp).toBe("org_a|client_b|wf_c|cat_d|err_e");
  });

  it("produces different fingerprints for different organizations", () => {
    const fp1 = normalizeFingerprint({
      organizationId: "org-A", clientId: "c1", category: "timeout", errorName: "Err",
    });
    const fp2 = normalizeFingerprint({
      organizationId: "org-B", clientId: "c1", category: "timeout", errorName: "Err",
    });
    expect(fp1).not.toBe(fp2);
  });

  it("produces different fingerprints for different clients", () => {
    const fp1 = normalizeFingerprint({
      organizationId: "org-A", clientId: "c1", category: "timeout", errorName: "Err",
    });
    const fp2 = normalizeFingerprint({
      organizationId: "org-A", clientId: "c2", category: "timeout", errorName: "Err",
    });
    expect(fp1).not.toBe(fp2);
  });
});

describe("IncidentStateMachine", () => {
  const sm = createIncidentStateMachine();

  it("allows open → acknowledged", () => {
    expect(sm.canTransition("open", "acknowledged")).toBe(true);
  });

  it("allows open → resolved", () => {
    expect(sm.canTransition("open", "resolved")).toBe(true);
  });

  it("allows acknowledged → resolved", () => {
    expect(sm.canTransition("acknowledged", "resolved")).toBe(true);
  });

  it("allows resolved → open (reopen)", () => {
    expect(sm.canTransition("resolved", "open")).toBe(true);
  });

  it("allows acknowledged → open", () => {
    expect(sm.canTransition("acknowledged", "open")).toBe(true);
  });

  it("allows open → open (aggregate)", () => {
    expect(sm.canTransition("open", "open")).toBe(true);
  });

  it("does not allow resolved → acknowledged", () => {
    expect(sm.canTransition("resolved", "acknowledged")).toBe(false);
  });

  it("does not allow resolved → resolved", () => {
    expect(sm.canTransition("resolved", "resolved")).toBe(false);
  });

  it("validateTransition throws on invalid transition", () => {
    expect(() => {
      sm.validateTransition("resolved", "acknowledged");
    }).toThrow(
      "Invalid incident status transition",
    );
  });

  it("validateTransition does not throw on valid transition", () => {
    expect(() => {
      sm.validateTransition("open", "acknowledged");
    }).not.toThrow();
  });
});

describe("incidentCursorSchema", () => {
  function encodeCursor(sortValue: string, id: string): string {
    return Buffer.from(`${sortValue}|${id}`, "utf8").toString("base64url");
  }

  it("accepts a valid cursor", () => {
    const cursor = encodeCursor("2024-01-01T00:00:00.000Z", "00000000-0000-0000-0000-000000000001");
    expect(incidentCursorSchema.safeParse(cursor).success).toBe(true);
  });

  it("rejects an empty cursor", () => {
    expect(incidentCursorSchema.safeParse("").success).toBe(false);
  });

  it("rejects a cursor with non-base64url characters", () => {
    expect(incidentCursorSchema.safeParse("!!!invalid!!!").success).toBe(false);
  });

  it("rejects a cursor with invalid UUID", () => {
    const cursor = Buffer.from("2024-01-01T00:00:00.000Z|not-a-uuid", "utf8").toString("base64url");
    expect(incidentCursorSchema.safeParse(cursor).success).toBe(false);
  });

  it("rejects a cursor with invalid date", () => {
    const cursor = Buffer.from("not-a-date|00000000-0000-0000-0000-000000000001", "utf8").toString("base64url");
    expect(incidentCursorSchema.safeParse(cursor).success).toBe(false);
  });
});

describe("incidentsListQuerySchema", () => {
  it("accepts valid query parameters", () => {
    const result = incidentsListQuerySchema.safeParse({
      clientId: "00000000-0000-0000-0000-000000000001",
      limit: 50,
      status: "open",
      severity: "high",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const result = incidentsListQuerySchema.safeParse({ status: "invalid_status" });
    expect(result.success).toBe(false);
  });

  it("rejects dateFrom > dateTo", () => {
    const result = incidentsListQuerySchema.safeParse({
      dateFrom: "2024-01-02T00:00:00.000Z",
      dateTo: "2024-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts dateFrom <= dateTo", () => {
    const result = incidentsListQuerySchema.safeParse({
      dateFrom: "2024-01-01T00:00:00.000Z",
      dateTo: "2024-01-02T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects limit > 100", () => {
    const result = incidentsListQuerySchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects limit < 1", () => {
    const result = incidentsListQuerySchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });
});

describe("acknowledgeIncidentRequestSchema", () => {
  it("requires an optimistic expectedStatus", () => {
    expect(acknowledgeIncidentRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts expectedStatus", () => {
    expect(acknowledgeIncidentRequestSchema.safeParse({ expectedStatus: "open" }).success).toBe(true);
  });

  it("rejects invalid expectedStatus", () => {
    expect(acknowledgeIncidentRequestSchema.safeParse({ expectedStatus: "invalid" }).success).toBe(false);
  });
});

describe("resolveIncidentRequestSchema", () => {
  it("requires an optimistic expectedStatus", () => {
    expect(resolveIncidentRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts expectedStatus", () => {
    expect(resolveIncidentRequestSchema.safeParse({ expectedStatus: "acknowledged" }).success).toBe(true);
  });
});

describe("incidentDtoSchema", () => {
  it("validates a complete incident DTO", () => {
    const dto = {
      id: "00000000-0000-0000-0000-000000000001",
      organizationId: "00000000-0000-0000-0000-000000000002",
      clientId: "00000000-0000-0000-0000-000000000003",
      integrationId: "00000000-0000-0000-0000-000000000004",
      workflowId: null,
      fingerprint: "test|fingerprint",
      category: "retryable",
      severity: "high",
      status: "open",
      occurrenceCount: 5,
      errorSummary: "Something failed",
      firstSeenAt: "2024-01-01T00:00:00.000Z",
      lastSeenAt: "2024-01-02T00:00:00.000Z",
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    expect(incidentDtoSchema.safeParse(dto).success).toBe(true);
  });

  it("rejects negative occurrenceCount", () => {
    const dto = {
      id: "00000000-0000-0000-0000-000000000001",
      organizationId: "00000000-0000-0000-0000-000000000002",
      clientId: "00000000-0000-0000-0000-000000000003",
      integrationId: "00000000-0000-0000-0000-000000000004",
      workflowId: null,
      fingerprint: "test",
      category: "retryable",
      severity: "high",
      status: "open",
      occurrenceCount: 0,
      errorSummary: null,
      firstSeenAt: "2024-01-01T00:00:00.000Z",
      lastSeenAt: "2024-01-02T00:00:00.000Z",
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    expect(incidentDtoSchema.safeParse(dto).success).toBe(false);
  });
});
