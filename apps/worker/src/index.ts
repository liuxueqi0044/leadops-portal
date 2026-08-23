import PgBoss from "pg-boss";
import { createDatabase } from "@leadops/db/client";
import {
  createLogger,
  serializeSafeError,
  initTelemetry,
  shutdownTelemetry,
  isTelemetryEnabled,
  recordDeadLetter,
  recordQueueRetry,
} from "@leadops/observability";
import { createFakeAlertProvider, createWebhookAlertProvider } from "@leadops/alert";
import { createWorkerRuntime, defaultTimers } from "./runtime.js";
import { createOutboxDispatcher } from "./dispatcher.js";
import {
  setQualificationProviderFactory,
} from "./lead-projectors.js";
import { createQualificationProviderFromEnv } from "./qualification-provider.js";
import {
  createApprovalExpireScheduler,
  createApprovalDeliveryEnqueueScheduler,
  createEmailDeliveryEnqueueScheduler,
  createWeeklyReportScheduler,
  createRetentionScheduler,
} from "./scheduler.js";
import {
  JOB_DEFINITIONS,
  getJob,
  isEnabled,
  getDisabledJobs,
} from "./jobs/registry.js";
import { createJobWrapper, type JobWrapper, JobError } from "./jobs/wrapper.js";
import { handleEventsProject } from "./handlers/events-project.js";
import { handleLeadsQualify } from "./handlers/leads-qualify.js";
import { handleApprovalsExpire } from "./handlers/approvals-expire.js";
import { handleApprovalsDeliverResult } from "./handlers/approvals-deliver-result.js";
import { handleEmailsSend, setEmailProvider } from "./handlers/emails-send.js";
import { handleIncidentsOpenFromFailure } from "./handlers/incidents-open-from-failure.js";
import { handleReportsGenerateWeekly } from "./handlers/reports-generate-weekly.js";
import { handleRetentionPrune } from "./handlers/retention-prune.js";
import { createFakeEmailProvider, createResendEmailProvider } from "@leadops/email";
import { validateProductionConfig } from "@leadops/core";

const logger = createLogger({ service: "worker" });

const prodConfig = validateProductionConfig(process.env, "worker");
if (!prodConfig.valid) {
  logger.fatal(
    { event: "worker.configuration_error", errors: prodConfig.errors },
    "Production configuration validation failed: " + prodConfig.errors.join("; "),
  );
  process.exit(1);
}
logger.info({ event: "worker.config_valid", environment: prodConfig.environment }, "Configuration validated");

const alertProvider = process.env.ALERT_WEBHOOK_URL
  ? createWebhookAlertProvider({ webhookUrl: process.env.ALERT_WEBHOOK_URL })
  : createFakeAlertProvider();

const workerDatabaseUrl = process.env.WORKER_DATABASE_URL;
if (!workerDatabaseUrl) {
  logger.fatal(
    { event: "worker.configuration_error" },
    "WORKER_DATABASE_URL is required and must use the dedicated worker role",
  );
  process.exit(1);
}

let qualificationProvider;
try {
  qualificationProvider = createQualificationProviderFromEnv(process.env);
} catch (error) {
  logger.fatal(
    {
      event: "worker.configuration_error",
      reason: error instanceof Error ? error.message : "Invalid AI provider configuration",
    },
    "AI qualification provider configuration is invalid",
  );
  process.exit(1);
}
setQualificationProviderFactory(() => qualificationProvider);

const emailProviderEnv = process.env.EMAIL_PROVIDER ?? "fake";
if (emailProviderEnv === "fake") {
  if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "development") {
    logger.fatal(
      { event: "worker.email_provider_error" },
      "EMAIL_PROVIDER=fake is only allowed in test or development",
    );
    process.exit(1);
  }
  setEmailProvider(createFakeEmailProvider());
  logger.info({ event: "worker.email_provider", provider: "fake" }, "Using fake email provider");
} else if (emailProviderEnv === "resend") {
  const resendApiKey = process.env.RESEND_API_KEY;
  const resendFrom = process.env.RESEND_FROM;

  if (!resendApiKey || resendApiKey === "re_placeholder") {
    logger.fatal(
      { event: "worker.email_provider_error" },
      "RESEND_API_KEY is required for EMAIL_PROVIDER=resend",
    );
    process.exit(1);
  }
  if (!resendFrom) {
    logger.fatal(
      { event: "worker.email_provider_error" },
      "RESEND_FROM is required for EMAIL_PROVIDER=resend",
    );
    process.exit(1);
  }

  setEmailProvider(createResendEmailProvider({ apiKey: resendApiKey, from: resendFrom }));
  logger.info({ event: "worker.email_provider", provider: "resend" }, "Using Resend email provider");
} else {
  logger.fatal(
    { event: "worker.email_provider_error" },
    "Unsupported EMAIL_PROVIDER '" + emailProviderEnv + "'. Supported: fake, resend",
  );
  process.exit(1);
}

const database = createDatabase(workerDatabaseUrl);
const pgBossSchema =
  process.env.PG_BOSS_SCHEMA ??
  (new URL(workerDatabaseUrl).username === "leadops_worker_test" ? "pgboss_test" : "pgboss");

const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS) || 30_000;
const shutdownTimeoutMs = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS) || 10_000;
const pollIntervalMs = Number(process.env.OUTBOX_POLL_MS) || 5_000;
const batchSize = Number(process.env.OUTBOX_BATCH_SIZE) || 10;
const concurrency = Math.max(1, Number(process.env.OUTBOX_CONCURRENCY) || 4);
const workerId = process.env.WORKER_ID ?? `worker-${String(process.pid)}`;
const approvalPollIntervalMs = Number(process.env.APPROVAL_DELIVERY_POLL_MS) || 5_000;

const timers = defaultTimers();
let boss: PgBoss | null = null;
let shuttingDown = false;

const runtime = createWorkerRuntime({
  logger,
  database,
  heartbeatMs,
  shutdownTimeoutMs,
  timers,
});

function createJobWrapperForSql(): JobWrapper {
  return createJobWrapper({
    logger: logger.child({ component: "job-wrapper" }),
    sql: database.sql,
    onIncidentEscalation: async (event) => {
      logger.warn(
        {
          event: "worker.incident_escalation",
          jobName: event.jobName,
          organizationId: event.organizationId,
          clientId: event.clientId,
          errorName: event.errorName,
          errorCategory: event.errorCategory,
          attempt: event.attempt,
          retryLimit: event.retryLimit,
        },
        "Incident escalation: " + event.jobName + " failed permanently at attempt " + String(event.attempt) + "/" + String(event.retryLimit),
      );

      if (!event.organizationId || !event.clientId || !event.integrationId || !boss) {
        throw new Error("Incident escalation is missing a tenant binding or pg-boss runtime");
      }

      const occurrenceKey = (event.jobName + ":" + event.correlationId).slice(0, 500);
      const jobId = "incident-escalation-" + occurrenceKey;
      await boss.send("incidents.open-from-failure", {
        schemaVersion: 1,
        organizationId: event.organizationId,
        clientId: event.clientId,
        integrationId: event.integrationId,
        workflowId: event.workflowId,
        occurrenceKey,
        jobName: event.jobName,
        errorCategory: event.errorCategory,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        attempt: event.attempt,
        retryLimit: event.retryLimit,
        correlationId: event.correlationId,
      }, {
        singletonKey: jobId,
        singletonSeconds: 86_400,
        retryLimit: 3,
        retryDelay: 5,
        retryBackoff: true,
      });

      const category = event.jobName === "emails.send"
        ? "email_permanent_failure"
        : event.jobName === "approvals.deliver-result"
          ? "approval_callback_permanent_failure"
          : "queue_dead_letter";
      const alert = await alertProvider.send({
        body: {
          severity: "critical",
          category,
          title: "LeadOps worker job failed permanently",
          message: `${event.jobName} exhausted its delivery policy`,
          service: "worker",
          timestamp: new Date().toISOString(),
          correlationId: event.correlationId,
        },
        idempotencyKey: jobId,
      });
      if (!alert.ok) {
        logger.error(
          { event: "worker.alert_delivery_failed", category, retryable: alert.retryable },
          "External alert delivery failed",
        );
        if (alert.retryable) throw new Error("External alert delivery failed transiently");
      }
    },
  });
}

function wireHandlers(): void {
  const def = getJob("events.project");
  if (def) {
    def.handler = async (_payload, ctx) => {
      await handleEventsProject(
        ctx.sql,
        ctx.logger,
        _payload as { eventId: string; eventType: string; integrationId: string; organizationId: string; clientId: string },
      );
    };
  }

  const lqDef = getJob("leads.qualify");
  if (lqDef) {
    lqDef.handler = async (_payload, ctx) => {
      await handleLeadsQualify(
        ctx.sql,
        ctx.logger,
        _payload as { leadId: string; organizationId: string; clientId: string; integrationId: string; eventId?: string },
      );
    };
  }

  const aeDef = getJob("approvals.expire");
  if (aeDef) {
    aeDef.handler = async (_payload, ctx) => {
      await handleApprovalsExpire(
        ctx.sql,
        ctx.logger,
        _payload as { organizationId: string; clientId: string; integrationId: string },
      );
    };
  }

  const adrDef = getJob("approvals.deliver-result");
  if (adrDef) {
    adrDef.handler = async (_payload, ctx) => {
      await handleApprovalsDeliverResult(
        ctx.sql,
        ctx.logger,
        _payload as { deliveryId: string; organizationId: string; clientId: string; integrationId: string },
        workerId,
      );
    };
  }

  const esDef = getJob("emails.send");
  if (esDef) {
    esDef.handler = async (_payload, ctx) => {
      await handleEmailsSend(
        ctx.sql,
        ctx.logger,
        _payload as { deliveryId: string; organizationId: string; clientId: string; integrationId: string },
        workerId,
        ctx.signal,
      );
    };
  }

  const ioDef = getJob("incidents.open-from-failure");
  if (ioDef) {
    ioDef.handler = async (_payload, ctx) => {
      await handleIncidentsOpenFromFailure(
        ctx.sql,
        ctx.logger,
        _payload as {
          organizationId: string; clientId: string; integrationId: string;
          workflowId?: string; occurrenceKey: string; jobName: string; errorCategory: string;
          errorName: string; errorMessage: string; attempt: number;
          retryLimit: number; correlationId?: string;
        },
      );
    };
  }

  const rgwDef = getJob("reports.generate-weekly");
  if (rgwDef) {
    rgwDef.handler = async (_payload, ctx) => {
      await handleReportsGenerateWeekly(
        ctx.sql,
        ctx.logger,
        _payload as {
          organizationId: string; clientId: string; integrationId: string;
          periodStart: string; periodEnd: string; correlationId?: string;
        },
      );
    };
  }

  const rpDef = getJob("retention.prune-non-audit-data");
  if (rpDef) {
    rpDef.handler = async (_payload, ctx) => {
      await handleRetentionPrune(
        ctx.sql,
        ctx.logger,
        _payload as { dryRun?: boolean },
      );
    };
  }
}

const dispatcher = createOutboxDispatcher({
  logger: logger.child({ component: "outbox" }),
  database: database.sql,
  pollIntervalMs,
  batchSize,
  concurrency,
  workerId,
  timers,
  enqueueJob: async (item) => {
    if (!boss) return;
    const route = item.messageType;
    if (!isEnabled(route)) {
      throw new Error("Unknown or disabled outbox messageType: " + item.messageType);
    }
    const jobId = "outbox-" + item.id;
    const def = JOB_DEFINITIONS[route];
    await boss.send(route, item.payload, {
      singletonKey: jobId,
      singletonSeconds: 86400,
      retryLimit: def?.retryLimit ?? 10,
      retryDelay: def?.retryDelaySeconds ?? 5,
      retryBackoff: true,
    });
  },
});

const schedulerOptions = {
  logger: logger.child({ component: "scheduler" }),
  sql: database.sql,
  workerId,
  pollIntervalMs: Math.max(pollIntervalMs, approvalPollIntervalMs),
  batchSize,
  getBoss: () => boss,
};

const approvalExpireScheduler = createApprovalExpireScheduler(schedulerOptions);
const approvalDeliveryScheduler = createApprovalDeliveryEnqueueScheduler(schedulerOptions);
const emailDeliveryScheduler = createEmailDeliveryEnqueueScheduler(schedulerOptions);
const weeklyReportScheduler = createWeeklyReportScheduler({
  ...schedulerOptions,
  pollIntervalMs: Math.max(pollIntervalMs, 300_000), // poll every 5 minutes min
});

const retentionScheduler = createRetentionScheduler(schedulerOptions);

async function handleShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "worker.shutdown", signal }, "Shutting down");

  await retentionScheduler.shutdown();
  await weeklyReportScheduler.shutdown();
  await approvalExpireScheduler.shutdown();
  await approvalDeliveryScheduler.shutdown();
  await emailDeliveryScheduler.shutdown();
  await dispatcher.shutdown();

  if (boss) {
    await boss.stop({ timeout: 10_000 });
  }
  if (isTelemetryEnabled()) {
    await shutdownTelemetry(5000);
  }
  await runtime.shutdown(signal);
}

process.on("SIGTERM", () => {
  void handleShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void handleShutdown("SIGINT");
});
process.on("unhandledRejection", (reason: unknown) => {
  logger.error(
    { event: "worker.unhandled_rejection", reason: serializeSafeError(reason) },
    "Unhandled rejection",
  );
});

const telemetryReady = initTelemetry({
  serviceName: 'leadops-worker',
  environment: prodConfig.environment === 'staging' ? 'staging' : prodConfig.environment === 'production' ? 'production' : 'local',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: process.env.OTEL_ENABLED === 'true',
  logger,
}).then(() => {
  logger.info({ event: 'worker.telemetry_ready' }, 'Telemetry initialized');
});

telemetryReady.then(async () => {
  await runtime.start();
  boss = new PgBoss({
    connectionString: workerDatabaseUrl,
    schema: pgBossSchema,
    archiveCompletedAfterSeconds: 172_800,
  });
  boss.on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ event: "pgboss.error", error: message }, "pg-boss error");
  });

  await boss.start();

  wireHandlers();

  const wrapper = createJobWrapperForSql();

  const disabledJobs = getDisabledJobs();
  for (const name of disabledJobs) {
    logger.warn(
      { event: "job.disabled_startup", jobName: name, reason: "disabled_pending_phase_6b" },
      "Job " + name + " is disabled (disabled_pending_phase_6b)",
    );
  }

  for (const jobName of Object.keys(JOB_DEFINITIONS)) {
    const def = getJob(jobName);
    if (!def?.enabled) continue;

    await boss.createQueue(jobName);

    await boss.work(jobName, { batchSize: 1 }, async (jobs) => {
      if (!Array.isArray(jobs)) {
        jobs = [jobs];
      }
      for (const job of jobs) {
        try {
          await wrapper.execute(
            jobName,
            job.data,
            { jobId: job.id, attempt: Number((job as unknown as Record<string, unknown>).retrycount ?? 0) },
          );
        } catch (err) {
          if (err instanceof JobError) {
            if (err.code === "RETRYABLE" || err.code === "TIMEOUT") {
              recordQueueRetry(jobName);
              throw err;
            }
            const b = boss;
            if (b) {
              await b.fail(jobName, job.id);
            }
            recordDeadLetter(jobName, jobName);
            logger.error(
              {
                event: "pgboss.job_failed_permanent",
                jobName,
                jobId: job.id,
                errorCode: err.code,
              },
              "pg-boss job failed permanently: " + err.code,
            );
            return;
          }
          logger.error(
            {
              event: "pgboss.job_error",
              jobName,
              jobId: job.id,
              errorName: err instanceof Error ? err.name : "UnknownError",
            },
            "pg-boss job failed",
          );
          throw err;
        }
      }
    });
  }

  logger.info(
    {
      event: "pgboss.started",
      enabledJobs: Object.keys(JOB_DEFINITIONS).filter((n) => JOB_DEFINITIONS[n]?.enabled),
      disabledJobs,
    },
    "pg-boss started with job registry",
  );

  dispatcher.start();
  approvalExpireScheduler.start();
  approvalDeliveryScheduler.start();
  emailDeliveryScheduler.start();
  weeklyReportScheduler.start();
  retentionScheduler.start();
}).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(
    { event: "worker.fatal", error: message },
    "Worker failed to start",
  );
  process.exit(1);
});
