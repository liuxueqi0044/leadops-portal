import { describe, it, expect } from "vitest";
import {
  runQualification,
  runQualificationOrNeedsReview,
} from "./qualification-handler.js";
import type { QualificationHandlerOptions } from "./qualification-handler.js";
import { fakeProvider } from "./fake-provider.js";
import { createLeadQualificationPrompt } from "./prompt.js";
import type { QualificationProvider } from "./types.js";

const standardOptions: QualificationHandlerOptions = {
  provider: fakeProvider,
  prompt: createLeadQualificationPrompt(),
  providerName: "fake",
  modelName: "fake-v1",
  timeoutMs: 5000,
  maxRetries: 2,
  maxInputLength: 10000,
  maxCostCents: 100,
};

const validInput = {
  contactName: "John Doe",
  email: "john@example.com",
  phone: "555-1234",
  company: "ACME",
  message: "Looking for HVAC service",
  source: "website",
  serviceNeeded: "HVAC",
};

const validContext = { leadId: "lead-1", organizationId: "org-1", clientId: "client-1" };
const providerRequest = { systemMessage: "system", userMessage: "user", timeoutMs: 1000 };

describe("Qualification Handler", () => {
  it("returns valid qualification for good input", async () => {
    const result = await runQualification(validInput, validContext, standardOptions);
    expect(result.qualification).toBeDefined();
    expect(result.error).toBeUndefined();
    if (result.qualification) {
      expect(result.qualification.schemaVersion).toBe(1);
    }
  });

  it("return needs review on schema failure", async () => {
    const badReturn: QualificationProvider = {
      qualify: () => Promise.resolve({
        qualification: {
          schemaVersion: 1,
          score: "bad",
          decision: "qualified",
          reasons: ["x"],
          summary: "x",
          suggestedNextAction: "book_call",
          confidence: 0.5,
          riskFlags: [],
        },
      }),
    };

    const { needsReview } = await runQualificationOrNeedsReview(
      validInput,
      validContext,
      { ...standardOptions, provider: badReturn },
    );
    expect(needsReview).toBe(true);
  });

  it("rejects input exceeding max length", async () => {
    const result = await runQualification(
      { ...validInput, message: "x".repeat(10001) },
      validContext,
      { ...standardOptions, maxInputLength: 10000 },
    );
    expect(result.error).toBeDefined();
    if (result.error) {
      expect(result.error.code).toBe("INPUT_TOO_LONG");
    }
  });

  it("handles provider timeout with needs_review", async () => {
    const slowProvider: QualificationProvider = {
      qualify: async () => {
        await new Promise((r) => setTimeout(r, 10000));
        return fakeProvider.qualify(validInput, validContext, providerRequest);
      },
    };

    const { needsReview, aiResult } = await runQualificationOrNeedsReview(
      validInput,
      validContext,
      { ...standardOptions, provider: slowProvider, timeoutMs: 50, maxRetries: 0 },
    );
    expect(needsReview).toBe(true);
    expect(aiResult.error).toBeDefined();
  });

  it("handles provider throwing error with needs_review", async () => {
    const errorProvider: QualificationProvider = {
      qualify: async () => {
        await Promise.resolve();
        throw new Error("API error 503");
      },
    };

    const { needsReview } = await runQualificationOrNeedsReview(
      validInput,
      validContext,
      { ...standardOptions, provider: errorProvider, maxRetries: 0 },
    );
    expect(needsReview).toBe(true);
  });

  it("handles extra fields in output", async () => {
    const extraFieldProvider: QualificationProvider = {
      qualify: async () => {
        const base = await fakeProvider.qualify(validInput, validContext, providerRequest);
        const invalid = {
          ...(base.qualification as Record<string, unknown>),
          toolCall: "delete_db",
          command: "rm -rf",
        };
        return { ...base, qualification: invalid };
      },
    };

    const { needsReview } = await runQualificationOrNeedsReview(
      validInput,
      validContext,
      { ...standardOptions, provider: extraFieldProvider, maxRetries: 0 },
    );
    expect(needsReview).toBe(true);
  });

  it("returns BUDGET_EXCEEDED and preserves cost/usage metadata", async () => {
    const pricedProvider: QualificationProvider = {
      qualify: async () => {
        const base = await fakeProvider.qualify(validInput, validContext, providerRequest);
        return {
          ...base,
          usage: { input: 120, output: 40 },
          cost: { amountMinor: 101, currency: "USD" },
        };
      },
    };

    const result = await runQualification(validInput, validContext, {
      ...standardOptions,
      provider: pricedProvider,
      maxCostCents: 100,
    });

    expect(result.qualification).toBeUndefined();
    expect(result.error?.code).toBe("BUDGET_EXCEEDED");
    expect(result.metadata.tokens).toEqual({ input: 120, output: 40 });
    expect(result.metadata.cost).toEqual({ amountMinor: 101, currency: "USD" });
  });
});
