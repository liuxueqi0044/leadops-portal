import type postgres from "postgres";
import type { Logger } from "pino";
import type {
  JobContext,
  JobExecutionMeta,
  IncidentEscalationEvent,
} from "./types.js";
import { getJob } from "./registry.js";
import { createBackoff } from "./errors.js";
import { withIntegrationContext, z } from "@leadops/db";

export class JobError extends Error {
  constructor(
    message: string,
    public readonly code: "RETRYABLE" | "PERMANENT" | "INVALID_PAYLOAD" | "TIMEOUT",
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export interface JobWrapperOptions {
  logger: Logger;
  sql: postgres.Sql;
  onIncidentEscalation?: (event: IncidentEscalationEvent) => void | Promise<void>;
  clock?: () => number;
}

export interface JobWrapper {
  execute(
    jobName: string,
    rawPayload: unknown,
    meta: { jobId: string; attempt: number },
  ): Promise<JobExecutionMeta>;
}

export function createJobWrapper(options: JobWrapperOptions): JobWrapper {
  const { logger: parentLogger, sql, onIncidentEscalation, clock = Date.now } = options;

  return {
    async execute(jobName: string, rawPayload: unknown, meta: { jobId: string; attempt: number }) {
      const startTime = clock();

      const def = getJob(jobName);
      if (!def) {
        throw new JobError("Unknown job: " + jobName, "INVALID_PAYLOAD", { jobName });
      }

      if (!def.enabled) {
        const childLogger = parentLogger.child({ component: "job-wrapper", jobName, jobId: meta.jobId });
        childLogger.warn({ event: "job.disabled", jobName }, "Job " + jobName + " is disabled (disabled_pending_phase_6b)");
        throw new JobError("Job disabled: " + jobName, "PERMANENT", { jobName });
      }

      let parsed: Record<string, unknown> | null = null;
      try {
        const validationResult = (def.payloadSchema as z.ZodType<Record<string, unknown>>).safeParse(rawPayload);
        if (!validationResult.success) {
          const childLogger = parentLogger.child({ component: "job-wrapper", jobName, jobId: meta.jobId });
          childLogger.error(
            { event: "job.payload_validation_failed", errors: validationResult.error.issues },
            "Job payload validation failed",
          );
          throw new JobError("Payload validation failed", "INVALID_PAYLOAD", {
            issues: validationResult.error.issues.map((i) => i.message),
          });
        }
        parsed = validationResult.data;
      } catch (err) {
        if (err instanceof JobError) throw err;
        const childLogger = parentLogger.child({ component: "job-wrapper", jobName, jobId: meta.jobId });
        childLogger.error(
          { event: "job.payload_parse_error", error: err instanceof Error ? err.message : String(err) },
          "Unexpected error parsing job payload",
        );
        throw new JobError("Payload parse error", "INVALID_PAYLOAD");
      }

      const correlationId =
        typeof parsed.correlationId === "string" && parsed.correlationId.length > 0
          ? parsed.correlationId
          : meta.jobId;

      const logger = parentLogger.child({
        component: "job-wrapper",
        jobName,
        jobId: meta.jobId,
        correlationId,
        attempt: meta.attempt,
      });

      const organizationId =
        typeof parsed.organizationId === "string" ? parsed.organizationId : undefined;
      const clientId =
        typeof parsed.clientId === "string" ? parsed.clientId : undefined;
      const integrationId =
        typeof parsed.integrationId === "string" ? parsed.integrationId : undefined;
      const workflowId =
        typeof parsed.workflowId === "string" ? parsed.workflowId : undefined;

      const escalateIfTerminal = async (
        code: JobError["code"],
        errorName: string,
        errorMessage: string,
      ): Promise<void> => {
        if (!onIncidentEscalation || jobName === "incidents.open-from-failure") return;
        const exhaustedRetry =
          (code === "RETRYABLE" || code === "TIMEOUT") && meta.attempt >= def.retryLimit;
        if (code !== "PERMANENT" && !exhaustedRetry) return;

        try {
          await onIncidentEscalation({
            jobName,
            organizationId,
            clientId,
            integrationId,
            workflowId,
            correlationId,
            errorCategory:
              code === "PERMANENT" ? "permanent" : code === "TIMEOUT" ? "timeout" : "retryable",
            errorName,
            errorMessage,
            attempt: meta.attempt,
            retryLimit: def.retryLimit,
          });
        } catch (escalationError) {
          logger.error(
            {
              event: "job.incident_enqueue_failed",
              error: escalationError instanceof Error ? escalationError.message : String(escalationError),
            },
            "Failed to enqueue terminal job incident",
          );
          throw new JobError("Incident escalation enqueue failed", "RETRYABLE", {
            originalErrorName: errorName,
          });
        }
      };

      const tenantBinding =
        def.tenantScope === "tenant" && organizationId && clientId && integrationId
          ? { organizationId, clientId, integrationId }
          : null;
      if (def.tenantScope === "tenant" && tenantBinding === null) {
        logger.error(
          { event: "job.missing_tenant_context" },
          "Tenant-scoped job missing organizationId, clientId, or integrationId",
        );
        throw new JobError("Missing tenant context", "INVALID_PAYLOAD");
      }
      if (tenantBinding) {
        await withIntegrationContext(sql, tenantBinding, async (tx) => {
          const rows = await tx.unsafe(
            "SELECT app_machine_can_access($1::uuid, $2::uuid, $3::uuid) AS allowed",
            [
              tenantBinding.organizationId,
              tenantBinding.clientId,
              tenantBinding.integrationId,
            ],
          );
          if (!(rows[0] as Record<string, unknown> | undefined)?.allowed) {
            throw new JobError("Tenant binding mismatch", "PERMANENT");
          }
        });
      }

      const abortController = new AbortController();
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          abortController.abort();
          const timeoutError = new Error(`Job timed out after ${String(def.timeout)}ms`);
          timeoutError.name = "TimeoutError";
          reject(timeoutError);
        }, def.timeout);
      });

      try {
        const context: JobContext = {
          jobId: meta.jobId,
          jobName: def.name,
          attempt: meta.attempt,
          correlationId,
          organizationId,
          clientId,
          integrationId,
          workflowId,
          signal: abortController.signal,
          logger,
          sql,
        };
        await Promise.race([def.handler(parsed, context), timeoutPromise]);

        if (timeoutTimer) clearTimeout(timeoutTimer);
        const latencyMs = clock() - startTime;
        logger.info(
          {
            event: "job.success",
            jobName,
            jobId: meta.jobId,
            attempt: meta.attempt,
            latencyMs,
          },
          "Job " + jobName + " completed",
        );

        return {
          jobId: meta.jobId,
          jobName,
          attempt: meta.attempt,
          correlationId,
          latencyMs,
          result: "success",
        };
      } catch (error) {
        if (timeoutTimer) clearTimeout(timeoutTimer);

        if (error instanceof JobError) {
          const latencyMs = clock() - startTime;
          logger.warn(
            {
              event: "job.failed",
              jobName,
              jobId: meta.jobId,
              attempt: meta.attempt,
              errorName: error.name,
              errorCode: error.code,
              latencyMs,
            },
            "Job " + jobName + " failed: " + error.code,
          );

          await escalateIfTerminal(error.code, error.name, error.message);
          throw error;
        }

        const errorName = error instanceof Error ? error.name : "UnknownError";
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const latencyMs = clock() - startTime;

        const isTimeout =
          errorName === "TimeoutError" ||
          errorName === "AbortError" ||
          (typeof error === "object" && error !== null && "code" in error && (error as Record<string, unknown>).code === "UND_ERR_HEADERS_TIMEOUT") ||
          abortController.signal.aborted;

        const isPermanent =
          errorName === "PermanentEmailError" ||
          errorName === "PermanentDeliveryError" ||
          errorMessage === "JOB_DISABLED" ||
          errorMessage === "TENANT_BINDING_MISMATCH";

        const code = isTimeout ? "TIMEOUT" : isPermanent ? "PERMANENT" : "RETRYABLE";

        logger.error(
          {
            event: "job.failed",
            jobName,
            jobId: meta.jobId,
            attempt: meta.attempt,
            errorName,
            errorCode: code,
            errorMessage: errorMessage.length > 500 ? errorMessage.slice(0, 500) + "..." : errorMessage,
            latencyMs,
          },
          "Job " + jobName + " failed",
        );

        await escalateIfTerminal(code, errorName, errorMessage);

        throw new JobError(errorMessage, code, { originalErrorName: errorName });
      }
    },
  };
}

export { createBackoff };
export { classifyError } from "./errors.js";
