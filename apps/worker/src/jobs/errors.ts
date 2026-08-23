import type { ErrorCategory, IncidentEscalationEvent } from "./types.js";

export function classifyError(error: unknown): ErrorCategory {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timeout";
    }
    if (error.name === "ZodError" || error.name === "ValidationError") {
      return "invalid-payload";
    }
    const code = (error as Error & { code?: string }).code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
      return "retryable";
    }
    if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
      return "timeout";
    }
    if (error.message === "JOB_DISABLED") {
      return "permanent";
    }
    if (error.message === "TENANT_BINDING_MISMATCH") {
      return "permanent";
    }
  }
  if (typeof error === "object" && error !== null) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 429 || (statusCode && statusCode >= 500)) {
      return "retryable";
    }
    if (statusCode === 400 || statusCode === 403 || statusCode === 404) {
      return "permanent";
    }
  }
  return "retryable";
}

export function createIncidentEscalationEvent(params: {
  jobName: string;
  organizationId?: string;
  clientId?: string;
  correlationId: string;
  error: unknown;
  attempt: number;
  retryLimit: number;
}): IncidentEscalationEvent {
  const errorName = params.error instanceof Error ? params.error.name : "UnknownError";
  const errorMessage = params.error instanceof Error ? params.error.message : "Unknown error";
  return {
    jobName: params.jobName,
    organizationId: params.organizationId,
    clientId: params.clientId,
    correlationId: params.correlationId,
    errorCategory: classifyError(params.error),
    errorName,
    errorMessage,
    attempt: params.attempt,
    retryLimit: params.retryLimit,
  };
}

export function createBackoff(attempt: number, baseDelayMs: number, clock: () => number): number {
  const exponent = Math.min(attempt, 10);
  const jitter = (clock() % 1000) / 1000;
  return Math.floor(baseDelayMs * Math.pow(2, exponent - 1) + jitter * baseDelayMs);
}
