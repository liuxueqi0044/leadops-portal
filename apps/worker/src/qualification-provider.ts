import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, Output } from "ai";
import {
  fakeProvider,
  type LeadQualification,
  type QualificationProvider,
} from "@leadops/core";

export interface QualificationProviderRegistration {
  provider: QualificationProvider;
  providerName: string;
  modelName: string;
}

type Environment = Record<string, string | undefined>;

function requireValue(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the configured AI provider`);
  return value;
}

function requirePositiveNumber(env: Environment, name: string): number {
  const raw = requireValue(env, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

const qualificationJsonSchema = jsonSchema<LeadQualification>({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "score",
    "decision",
    "reasons",
    "summary",
    "suggestedNextAction",
    "confidence",
    "riskFlags",
  ],
  properties: {
    schemaVersion: { const: 1 },
    score: { type: "integer", minimum: 0, maximum: 100 },
    decision: { enum: ["qualified", "needs_review", "disqualified"] },
    reasons: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
    summary: { type: "string", minLength: 1, maxLength: 500 },
    suggestedNextAction: {
      enum: ["request_approval", "book_call", "send_nurture", "discard"],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    riskFlags: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
  },
});

export function createQualificationProviderFromEnv(
  env: Environment = process.env,
): QualificationProviderRegistration {
  const providerName = requireValue(env, "AI_PROVIDER").toLowerCase();

  if (providerName === "fake") {
    if (env.NODE_ENV !== "test" && env.NODE_ENV !== "development") {
      throw new Error("AI_PROVIDER=fake is allowed only in test or development");
    }
    return { provider: fakeProvider, providerName: "fake", modelName: "fake-v1" };
  }

  if (providerName !== "openai") {
    throw new Error(`Unsupported AI_PROVIDER '${providerName}'`);
  }

  const apiKey = requireValue(env, "AI_API_KEY");
  const modelName = requireValue(env, "AI_MODEL");
  const inputUsdPerMillion = requirePositiveNumber(env, "AI_INPUT_USD_PER_MILLION_TOKENS");
  const outputUsdPerMillion = requirePositiveNumber(env, "AI_OUTPUT_USD_PER_MILLION_TOKENS");
  const maxOutputTokens = Math.floor(requirePositiveNumber(env, "AI_MAX_OUTPUT_TOKENS"));
  const baseURL = env.AI_BASE_URL?.trim();

  const openai = createOpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  const provider: QualificationProvider = {
    async qualify(_input, _context, request) {
      const result = await generateText({
        model: openai(modelName),
        system: request.systemMessage,
        prompt: request.userMessage,
        output: Output.object({
          schema: qualificationJsonSchema,
          name: "lead_qualification",
          description: "A structured, non-executable assessment of one business lead",
        }),
        maxOutputTokens,
        maxRetries: 0,
        timeout: request.timeoutMs,
      });

      const inputTokens = result.usage.inputTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? 0;
      const costUsd =
        (inputTokens / 1_000_000) * inputUsdPerMillion
        + (outputTokens / 1_000_000) * outputUsdPerMillion;

      return {
        qualification: result.output,
        usage: { input: inputTokens, output: outputTokens },
        cost: { amountMinor: Math.ceil(costUsd * 100), currency: "USD" },
      };
    },
  };

  return { provider, providerName: "openai", modelName };
}
