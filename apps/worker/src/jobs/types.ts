import type { Logger } from "pino";
import type postgres from "postgres";
import { z as zod } from "@leadops/db";
import type { ZodType } from "@leadops/db";

export type ErrorCategory =
  | "retryable"
  | "permanent"
  | "invalid-payload"
  | "timeout";

export type TenantScope = "tenant" | "system";

export interface JobContext {
  jobId: string;
  jobName: string;
  attempt: number;
  correlationId: string;
  organizationId?: string;
  clientId?: string;
  integrationId?: string;
  workflowId?: string;
  signal: AbortSignal;
  logger: Logger;
  sql: postgres.Sql;
}

export interface JobDefinition {
  name: string;
  schemaVersion: number;
  payloadSchema: ZodType<unknown>;
  tenantScope: TenantScope;
  timeout: number;
  retryLimit: number;
  retryDelaySeconds: number;
  enabled: boolean;
  idempotencyStrategy: string;
  failureClassification: (error: unknown) => ErrorCategory;
  handler: (payload: unknown, context: JobContext) => Promise<void>;
}

export interface JobExecutionMeta {
  jobId: string;
  jobName: string;
  attempt: number;
  correlationId: string;
  latencyMs: number;
  result: "success" | "failure" | "timeout" | "invalid_payload";
  errorCategory?: ErrorCategory;
  errorName?: string;
}

export interface IncidentEscalationEvent {
  jobName: string;
  organizationId?: string;
  clientId?: string;
  integrationId?: string;
  workflowId?: string;
  correlationId: string;
  errorCategory: ErrorCategory;
  errorName: string;
  errorMessage: string;
  attempt: number;
  retryLimit: number;
}

export interface ShutdownState {
  stopping: boolean;
  inFlightCount: number;
}

export function createPayloadSchema() {
  return zod.object({
    schemaVersion: zod.number().int().positive(),
    correlationId: zod.string().optional(),
    organizationId: zod.string().uuid().optional(),
    clientId: zod.string().uuid().optional(),
    integrationId: zod.string().uuid().optional(),
  });
}
