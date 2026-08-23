import type {
  QualificationProvider,
  QualificationInput,
  LeadQualification,
  AIProviderResult,
} from "./types.js";
import { leadQualificationSchema } from "./types.js";
import type { PromptTemplate } from "./prompt.js";

export interface QualificationHandlerOptions {
  provider: QualificationProvider;
  prompt: PromptTemplate;
  providerName: string;
  modelName: string;
  timeoutMs: number;
  maxRetries: number;
  maxInputLength: number;
  maxCostCents: number;
}

export async function runQualification(
  input: QualificationInput,
  context: { leadId: string; organizationId: string; clientId: string },
  options: QualificationHandlerOptions,
): Promise<AIProviderResult> {
  const startTime = Date.now();

  const messageLength = input.message.length;
  if (messageLength > options.maxInputLength) {
    return {
      error: {
        code: "INPUT_TOO_LONG",
        message: `Message exceeds max length of ${String(options.maxInputLength)}`,
        retryable: false,
      },
      metadata: {
        provider: options.providerName,
        model: options.modelName,
        promptVersion: options.prompt.version,
        inputHash: "error",
        latencyMs: Date.now() - startTime,
      },
    };
  }

  const { userMessage, inputHash } = options.prompt.buildUserMessage({
    contactName: input.contactName || "",
    email: input.email || "",
    phone: input.phone || "",
    company: input.company || "",
    source: input.source || "",
    serviceNeeded: input.serviceNeeded || "",
    message: input.message || "",
  });

  // Check actual input length sent to provider (including system prompt overhead)
  if (userMessage.length > options.maxInputLength) {
    return {
      error: {
        code: "INPUT_TOO_LONG",
        message: `Built prompt exceeds max length of ${String(options.maxInputLength)}`,
        retryable: false,
      },
      metadata: {
        provider: options.providerName,
        model: options.modelName,
        promptVersion: options.prompt.version,
        inputHash,
        latencyMs: Date.now() - startTime,
      },
    };
  }

  let lastError: { code: string; message: string; retryable: boolean } | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const result = await withTimeout(
        options.provider.qualify(input, context, {
          systemMessage: options.prompt.systemMessage,
          userMessage,
          timeoutMs: options.timeoutMs,
        }),
        options.timeoutMs,
      );

      const metadata = {
        provider: options.providerName,
        model: options.modelName,
        promptVersion: options.prompt.version,
        inputHash,
        ...(result.usage ? { tokens: result.usage } : {}),
        ...(result.cost ? { cost: result.cost } : {}),
        latencyMs: Date.now() - startTime,
      };

      if (result.cost) {
        const { amountMinor, currency } = result.cost;
        if (
          !Number.isSafeInteger(amountMinor)
          || amountMinor < 0
          || !/^[A-Z]{3}$/.test(currency)
        ) {
          return {
            error: {
              code: "PROVIDER_METADATA_INVALID",
              message: "Provider returned invalid cost metadata",
              retryable: false,
            },
            metadata,
          };
        }

        if (amountMinor > options.maxCostCents) {
          return {
            error: {
              code: "BUDGET_EXCEEDED",
              message: `Provider cost ${String(amountMinor)} minor units exceeds max ${String(options.maxCostCents)}`,
              retryable: false,
            },
            metadata,
          };
        }
      }

      if (result.usage && (
        !Number.isSafeInteger(result.usage.input)
        || result.usage.input < 0
        || !Number.isSafeInteger(result.usage.output)
        || result.usage.output < 0
      )) {
        return {
          error: {
            code: "PROVIDER_METADATA_INVALID",
            message: "Provider returned invalid token usage metadata",
            retryable: false,
          },
          metadata,
        };
      }

      const validated = leadQualificationSchema.safeParse(result.qualification);
      if (!validated.success) {
        return {
          error: {
            code: "SCHEMA_VALIDATION_FAILED",
            message: `Qualification output failed schema validation: ${validated.error.message}`,
            retryable: false,
          },
          metadata,
        };
      }

      return {
        qualification: validated.data,
        metadata,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("timeout")) {
        lastError = {
          code: "TIMEOUT",
          message: `Qualification timed out after ${String(options.timeoutMs)}ms`,
          retryable: attempt < options.maxRetries,
        };
      } else {
        lastError = {
          code: "PROVIDER_ERROR",
          message,
          retryable: attempt < options.maxRetries,
        };
      }

      if (!lastError.retryable) break;
    }
  }

  return {
    error: lastError ?? {
      code: "UNKNOWN_ERROR",
      message: "Qualification failed for unknown reason",
      retryable: false,
    },
    metadata: {
      provider: options.providerName,
      model: options.modelName,
      promptVersion: options.prompt.version,
      inputHash,
      latencyMs: Date.now() - startTime,
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout: operation exceeded ${String(timeoutMs)}ms`));
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

export async function runQualificationOrNeedsReview(
  input: QualificationInput,
  context: { leadId: string; organizationId: string; clientId: string },
  options: QualificationHandlerOptions,
): Promise<{
  qualification: LeadQualification | null;
  aiResult: AIProviderResult;
  needsReview: boolean;
}> {
  const result = await runQualification(input, context, options);

  if (result.qualification && !result.error) {
    return { qualification: result.qualification, aiResult: result, needsReview: false };
  }

  return {
    qualification: null,
    aiResult: result,
    needsReview: true,
  };
}
