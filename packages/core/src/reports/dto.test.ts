import { describe, expect, it } from "vitest";
import {
  weeklyMetricsSchema,
  zeroMetrics,
  calculateWeekInterval,
  calculatePreviousWeekInterval,
  GENERATION_VERSION,
  reportsListQuerySchema,
  reportsCursorSchema,
  reportSnapshotDtoSchema,
} from "./dto.js";

describe("weeklyMetricsSchema", () => {
  it("accepts valid metrics", () => {
    const metrics = {
      leadsReceived: 10,
      qualificationRate: 0.5,
      approvalConversion: 0.8,
      appointments: 3,
      workflowSuccess: 15,
      workflowFailure: 2,
      openIncidents: 1,
      resolvedIncidents: 3,
    };
    expect(weeklyMetricsSchema.safeParse(metrics).success).toBe(true);
  });

  it("rejects negative values", () => {
    const metrics = {
      leadsReceived: -1,
      qualificationRate: 0.5,
      approvalConversion: 0.8,
      appointments: 3,
      workflowSuccess: 15,
      workflowFailure: 2,
      openIncidents: 1,
      resolvedIncidents: 3,
    };
    expect(weeklyMetricsSchema.safeParse(metrics).success).toBe(false);
  });

  it("rejects rate > 1", () => {
    const metrics = {
      leadsReceived: 10,
      qualificationRate: 1.5,
      approvalConversion: 0.8,
      appointments: 3,
      workflowSuccess: 15,
      workflowFailure: 2,
      openIncidents: 1,
      resolvedIncidents: 3,
    };
    expect(weeklyMetricsSchema.safeParse(metrics).success).toBe(false);
  });
});

describe("zeroMetrics", () => {
  it("returns all zeros and zero rates", () => {
    const m = zeroMetrics();
    expect(m.leadsReceived).toBe(0);
    expect(m.qualificationRate).toBe(0);
    expect(m.approvalConversion).toBe(0);
    expect(m.appointments).toBe(0);
    expect(m.workflowSuccess).toBe(0);
    expect(m.workflowFailure).toBe(0);
    expect(m.openIncidents).toBe(0);
    expect(m.resolvedIncidents).toBe(0);
  });
});

describe("calculateWeekInterval", () => {
  it("returns a 7-day interval starting on Monday 00:00 UTC for a given date", () => {
    // 2024-01-10 is a Wednesday
    const interval = calculateWeekInterval(new Date("2024-01-10T12:00:00Z"));
    expect(interval.periodStart.toISOString()).toBe("2024-01-08T00:00:00.000Z");
    expect(interval.periodEnd.toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });

  it("returns monday-based interval for a monday", () => {
    const interval = calculateWeekInterval(new Date("2024-01-08T12:00:00Z"));
    expect(interval.periodStart.toISOString()).toBe("2024-01-08T00:00:00.000Z");
    expect(interval.periodEnd.toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });

  it("returns monday-based interval for a sunday", () => {
    const interval = calculateWeekInterval(new Date("2024-01-14T12:00:00Z"));
    expect(interval.periodStart.toISOString()).toBe("2024-01-08T00:00:00.000Z");
    expect(interval.periodEnd.toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });

  it("periodStart is strictly before periodEnd", () => {
    const interval = calculateWeekInterval(new Date("2024-06-15T00:00:00Z"));
    expect(interval.periodStart.getTime()).toBeLessThan(interval.periodEnd.getTime());
  });

  it("handles cross-month intervals", () => {
    // 2024-01-31 is a Wednesday, its week starts Monday Jan 29, ends Feb 5
    const interval = calculateWeekInterval(new Date("2024-01-31T00:00:00Z"));
    expect(interval.periodStart.toISOString()).toBe("2024-01-29T00:00:00.000Z");
    expect(interval.periodEnd.toISOString()).toBe("2024-02-05T00:00:00.000Z");
  });

  it("handles cross-year intervals", () => {
    // 2024-12-31 is a Tuesday, its week starts Monday Dec 30, ends Jan 6 2025
    const interval = calculateWeekInterval(new Date("2024-12-31T00:00:00Z"));
    expect(interval.periodStart.toISOString()).toBe("2024-12-30T00:00:00.000Z");
    expect(interval.periodEnd.toISOString()).toBe("2025-01-06T00:00:00.000Z");
  });
});

describe("calculatePreviousWeekInterval", () => {
  it("returns the week before the current monday-based week", () => {
    const interval = calculatePreviousWeekInterval(new Date("2024-01-10T12:00:00Z"));
    expect(interval.periodStart.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(interval.periodEnd.toISOString()).toBe("2024-01-08T00:00:00.000Z");
  });

  it("returns a full week interval", () => {
    const interval = calculatePreviousWeekInterval(new Date("2024-01-08T12:00:00Z"));
    expect(interval.periodEnd.getTime() - interval.periodStart.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("reportsCursorSchema", () => {
  function encodeCursor(sortValue: string, id: string): string {
    return Buffer.from(`${sortValue}|${id}`, "utf8").toString("base64url");
  }

  it("accepts a valid cursor", () => {
    const cursor = encodeCursor("2024-01-01T00:00:00.000Z", "00000000-0000-0000-0000-000000000001");
    expect(reportsCursorSchema.safeParse(cursor).success).toBe(true);
  });

  it("rejects an empty cursor", () => {
    expect(reportsCursorSchema.safeParse("").success).toBe(false);
  });
});

describe("reportsListQuerySchema", () => {
  it("accepts valid parameters", () => {
    expect(reportsListQuerySchema.safeParse({ limit: 50 }).success).toBe(true);
  });

  it("rejects dateFrom > dateTo", () => {
    expect(reportsListQuerySchema.safeParse({
      dateFrom: "2024-01-02T00:00:00.000Z",
      dateTo: "2024-01-01T00:00:00.000Z",
    }).success).toBe(false);
  });
});

describe("GENERATION_VERSION", () => {
  it("is a positive integer", () => {
    expect(GENERATION_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(GENERATION_VERSION)).toBe(true);
  });
});

describe("reportSnapshotDtoSchema", () => {
  it("validates a complete snapshot DTO", () => {
    const dto = {
      id: "00000000-0000-0000-0000-000000000001",
      organizationId: "00000000-0000-0000-0000-000000000002",
      clientId: "00000000-0000-0000-0000-000000000003",
      periodStart: "2024-01-01T00:00:00.000Z",
      periodEnd: "2024-01-08T00:00:00.000Z",
      generationVersion: 1,
      metrics: {
        leadsReceived: 10,
        qualificationRate: 0.5,
        approvalConversion: 0.8,
        appointments: 3,
        workflowSuccess: 15,
        workflowFailure: 2,
        openIncidents: 1,
        resolvedIncidents: 3,
      },
      correlationId: null,
      generatedAt: "2024-01-08T01:00:00.000Z",
      createdAt: "2024-01-08T01:00:00.000Z",
    };
    expect(reportSnapshotDtoSchema.safeParse(dto).success).toBe(true);
  });

  it("rejects zero generationVersion", () => {
    const dto = {
      id: "00000000-0000-0000-0000-000000000001",
      organizationId: "00000000-0000-0000-0000-000000000002",
      clientId: "00000000-0000-0000-0000-000000000003",
      periodStart: "2024-01-01T00:00:00.000Z",
      periodEnd: "2024-01-08T00:00:00.000Z",
      generationVersion: 0,
      metrics: zeroMetrics(),
      correlationId: null,
      generatedAt: "2024-01-08T01:00:00.000Z",
      createdAt: "2024-01-08T01:00:00.000Z",
    };
    expect(reportSnapshotDtoSchema.safeParse(dto).success).toBe(false);
  });
});
