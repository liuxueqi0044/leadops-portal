import { describe, it, expect } from "vitest";
import {
  leadQualificationSchema,
  normalizeEmail,
  normalizePhone,
  normalizeCompany,
  computeDedupeKey,
  DEDUPE_VERSION,
} from "./types.js";

describe("LeadQualification schema", () => {
  const validQualification = {
    schemaVersion: 1 as const,
    score: 75,
    decision: "qualified" as const,
    reasons: ["Good fit"],
    summary: "A qualified lead",
    suggestedNextAction: "book_call" as const,
    confidence: 0.9,
    riskFlags: [],
  };

  it("accepts valid qualification", () => {
    expect(() => leadQualificationSchema.parse(validQualification)).not.toThrow();
  });

  it("rejects score as string", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      score: "75",
    });
    expect(result.success).toBe(false);
  });

  it("rejects score -1", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      score: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects score 101", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      score: 101,
    });
    expect(result.success).toBe(false);
  });

  it("rejects NaN score", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      score: NaN,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer score", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      score: 75.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects summary > 500 chars", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      summary: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("accepts summary at exactly 500 chars", () => {
    expect(() =>
      leadQualificationSchema.parse({
        ...validQualification,
        summary: "x".repeat(500),
      }),
    ).not.toThrow();
  });

  it("rejects empty reasons", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      reasons: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 5 reasons", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      reasons: ["a", "b", "c", "d", "e", "f"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields beyond schema", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      toolCall: "call_someone",
      commands: [{ type: "send_email" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid decision values", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      decision: "perfect",
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence > 1", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      confidence: 1.1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      confidence: -0.1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid suggestedNextAction", () => {
    const result = leadQualificationSchema.safeParse({
      ...validQualification,
      suggestedNextAction: "send_gift",
    });
    expect(result.success).toBe(false);
  });
});

describe("Normalization functions", () => {
  it("normalizeEmail lowercases and trims", () => {
    expect(normalizeEmail("  John@Example.COM  ")).toBe("john@example.com");
  });

  it("normalizeEmail returns empty for null", () => {
    expect(normalizeEmail(null)).toBe("");
  });

  it("normalizeEmail returns empty for undefined", () => {
    expect(normalizeEmail(undefined)).toBe("");
  });

  it("normalizePhone strips non-digit characters", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("normalizePhone returns empty for null", () => {
    expect(normalizePhone(null)).toBe("");
  });

  it("normalizeCompany trims", () => {
    expect(normalizeCompany("  Acme Corp  ")).toBe("Acme Corp");
  });
});

describe("computeDedupeKey", () => {
  it("uses externalId + source when available", () => {
    const key = computeDedupeKey({
      externalId: "lead-123",
      source: "n8n",
    });
    expect(key.version).toBe(DEDUPE_VERSION);
    expect(key.key).toBe("1:ext:n8n:lead-123");
  });

  it("uses normalized email + phone with source", () => {
    const key = computeDedupeKey({
      email: "John@Example.com",
      phone: "+1-555-123-4567",
      source: "website",
    });
    expect(key.key).toContain("john@example.com");
    expect(key.key).toContain("+15551234567");
    expect(key.key).toContain("website");
  });

  it("works without externalId", () => {
    const key = computeDedupeKey({
      email: "a@b.com",
    });
    expect(key.key).toContain("a@b.com");
  });

  it("returns unique fallback key when no usable identifiers", () => {
    const k1 = computeDedupeKey({});
    const k2 = computeDedupeKey({});
    expect(k1.key).toContain("1:none:");
    expect(k1.key).not.toBe(k2.key); // Unique per call
  });
});
