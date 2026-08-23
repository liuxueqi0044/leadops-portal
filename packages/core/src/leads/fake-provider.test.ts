import { describe, it, expect } from "vitest";
import { fakeProvider } from "./fake-provider.js";
import { leadQualificationSchema } from "./types.js";

describe("Fake Qualification Provider", () => {
  const request = { systemMessage: "system", userMessage: "user", timeoutMs: 1000 };

  it("produces valid deterministic output", async () => {
    const result = await fakeProvider.qualify(
      {
        contactName: "John Doe",
        email: "john@example.com",
        phone: "555-1234",
        company: "ACME Corp",
        message: "I need HVAC replacement for my warehouse",
        source: "website",
        serviceNeeded: "HVAC",
      },
      { leadId: "lead-1", organizationId: "org-1", clientId: "client-1" },
      request,
    );

    const parsed = leadQualificationSchema.parse(result.qualification);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.score).toBeGreaterThanOrEqual(0);
    expect(parsed.score).toBeLessThanOrEqual(100);
    expect(Number.isInteger(parsed.score)).toBe(true);
  });

  it("is deterministic for same input", async () => {
    const input = {
      contactName: "Jane",
      email: "jane@test.com",
      phone: "555-0000",
      company: "TestCo",
      message: "Need service",
      source: "web",
      serviceNeeded: "consulting",
    };
    const ctx = { leadId: "1", organizationId: "o1", clientId: "c1" };
    const a = await fakeProvider.qualify(input, ctx, request);
    const b = await fakeProvider.qualify(input, ctx, request);
    expect(a.qualification).toEqual(b.qualification);
  });

  it("returns valid decision enum", async () => {
    const result = await fakeProvider.qualify(
      {
        contactName: "Test",
        email: "low@score.com",
        phone: "",
        company: "",
        message: "a",
        source: "web",
        serviceNeeded: "",
      },
      { leadId: "1", organizationId: "o1", clientId: "c1" },
      request,
    );
    const parsed = leadQualificationSchema.parse(result.qualification);
    expect(["qualified", "needs_review", "disqualified"]).toContain(parsed.decision);
  });
});
