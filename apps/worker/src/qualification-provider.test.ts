import { describe, expect, it } from "vitest";

import { leadQualificationSchema } from "@leadops/core";
import { createQualificationProviderFromEnv } from "./qualification-provider.js";

describe("qualification provider configuration", () => {
  it("requires an explicit provider", () => {
    expect(() => createQualificationProviderFromEnv({ NODE_ENV: "development" }))
      .toThrow(/AI_PROVIDER is required/);
  });

  it("allows the deterministic fake only when explicitly selected outside production", async () => {
    const registration = createQualificationProviderFromEnv({
      NODE_ENV: "test",
      AI_PROVIDER: "fake",
    });
    expect(registration.providerName).toBe("fake");
    const result = await registration.provider.qualify(
      {
        contactName: "Test",
        email: "test@example.com",
        phone: "",
        company: "Test",
        message: "Need help",
        source: "test",
        serviceNeeded: "consulting",
      },
      { leadId: "lead", organizationId: "org", clientId: "client" },
      { systemMessage: "system", userMessage: "user", timeoutMs: 1000 },
    );
    expect(leadQualificationSchema.safeParse(result.qualification).success).toBe(true);
  });

  it("forbids the fake provider in production or an unspecified environment", () => {
    expect(() => createQualificationProviderFromEnv({
      NODE_ENV: "production",
      AI_PROVIDER: "fake",
    })).toThrow(/only in test or development/);
    expect(() => createQualificationProviderFromEnv({
      AI_PROVIDER: "fake",
    })).toThrow(/only in test or development/);
  });

  it("constructs the production adapter only with model, key, limits, and pricing", () => {
    const registration = createQualificationProviderFromEnv({
      NODE_ENV: "production",
      AI_PROVIDER: "openai",
      AI_API_KEY: "test-key-not-used",
      AI_MODEL: "gpt-test",
      AI_INPUT_USD_PER_MILLION_TOKENS: "1.25",
      AI_OUTPUT_USD_PER_MILLION_TOKENS: "5",
      AI_MAX_OUTPUT_TOKENS: "500",
    });
    expect(registration.providerName).toBe("openai");
    expect(registration.modelName).toBe("gpt-test");
  });
});
