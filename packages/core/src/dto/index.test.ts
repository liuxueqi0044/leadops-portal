import { describe, expect, it } from "vitest";

import {
  dashboardQuerySchema,
  leadCursorSchema,
  leadsListQuerySchema,
} from "./index.js";

describe("Phase 4 query DTOs", () => {
  it("accepts only canonical keyset cursors containing an ISO timestamp and UUID", () => {
    const valid = Buffer.from(
      "2026-08-09T00:00:00.000Z|00000000-0000-4000-8000-000000000001",
      "utf8",
    ).toString("base64url");

    expect(leadCursorSchema.safeParse(valid).success).toBe(true);
    expect(leadsListQuerySchema.safeParse({ cursor: valid }).success).toBe(true);
    expect(leadsListQuerySchema.safeParse({ cursor: "not-a-cursor" }).success).toBe(false);
    expect(leadsListQuerySchema.safeParse({
      cursor: Buffer.from("not-a-date|not-a-uuid").toString("base64url"),
    }).success).toBe(false);
  });

  it("rejects invalid and reversed dashboard date ranges", () => {
    expect(dashboardQuerySchema.safeParse({ dateFrom: "not-a-date" }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({
      dateFrom: "2026-08-10T00:00:00.000Z",
      dateTo: "2026-08-09T00:00:00.000Z",
    }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({
      dateFrom: "2026-08-09T00:00:00.000Z",
      dateTo: "2026-08-10T00:00:00.000Z",
    }).success).toBe(true);
  });
});
