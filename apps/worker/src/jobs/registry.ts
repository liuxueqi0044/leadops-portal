import { z } from "@leadops/db";
import type { JobDefinition, JobContext, ErrorCategory } from "./types.js";
import { classifyError } from "./errors.js";

const basePayload = z.object({
  schemaVersion: z.literal(1),
  correlationId: z.string().optional(),
  organizationId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  integrationId: z.string().uuid().optional(),
});

const eventsProjectPayload = basePayload.extend({
  eventId: z.string().uuid(),
  eventType: z.string().min(1),
  integrationId: z.string().uuid(),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
});

const leadsQualifyPayload = basePayload.extend({
  leadId: z.string().uuid(),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  integrationId: z.string().uuid(),
  eventId: z.string().uuid().optional(),
});

const approvalsExpirePayload = basePayload.extend({
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  integrationId: z.string().uuid(),
});

const approvalsDeliverResultPayload = basePayload.extend({
  deliveryId: z.string().uuid(),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  integrationId: z.string().uuid(),
});

const emailsSendPayload = basePayload.extend({
  deliveryId: z.string().uuid(),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  integrationId: z.string().uuid(),
});

const incidentsOpenFromFailurePayload = basePayload.extend({
  jobName: z.string().min(1),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  integrationId: z.string().uuid(),
  occurrenceKey: z.string().min(1).max(500),
  workflowId: z.string().uuid().optional(),
  errorCategory: z.enum(["retryable", "permanent", "invalid-payload", "timeout"]),
  errorName: z.string().min(1),
  errorMessage: z.string(),
  attempt: z.number().int().min(0),
  retryLimit: z.number().int().min(0),
});

const reportsGenerateWeeklyPayload = basePayload.extend({
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  integrationId: z.string().uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
}).superRefine((value, ctx) => {
  const start = new Date(value.periodStart);
  const end = new Date(value.periodEnd);
  const completeWeek =
    start.getUTCDay() === 1 &&
    start.getUTCHours() === 0 &&
    start.getUTCMinutes() === 0 &&
    start.getUTCSeconds() === 0 &&
    start.getUTCMilliseconds() === 0 &&
    end.getTime() - start.getTime() === 7 * 24 * 60 * 60 * 1000;
  if (!completeWeek) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "report period must be a complete UTC Monday week" });
  }
});

const retentionPrunePayload = basePayload.extend({
  dryRun: z.boolean().optional(),
});

export type EventsProjectPayload = z.infer<typeof eventsProjectPayload>;
export type LeadsQualifyPayload = z.infer<typeof leadsQualifyPayload>;
export type ApprovalsExpirePayload = z.infer<typeof approvalsExpirePayload>;
export type ApprovalsDeliverResultPayload = z.infer<typeof approvalsDeliverResultPayload>;
export type EmailsSendPayload = z.infer<typeof emailsSendPayload>;
export type IncidentsOpenFromFailurePayload = z.infer<typeof incidentsOpenFromFailurePayload>;
export type ReportsGenerateWeeklyPayload = z.infer<typeof reportsGenerateWeeklyPayload>;
export type RetentionPrunePayload = z.infer<typeof retentionPrunePayload>;

function defaultClassification(_error: unknown): ErrorCategory {
  void _error;
  return "retryable";
}

const NOOP_HANDLER = (_payload: unknown, _context: JobContext): Promise<void> => {
  void _payload;
  void _context;
  return Promise.reject(new Error("JOB_DISABLED"));
};

export const JOB_DEFINITIONS: Record<string, JobDefinition> = {
  "events.project": {
    name: "events.project",
    schemaVersion: 1,
    payloadSchema: eventsProjectPayload,
    tenantScope: "tenant",
    timeout: 60000,
    retryLimit: 10,
    retryDelaySeconds: 5,
    enabled: true,
    idempotencyStrategy: "event-projector-advisory-lock",
    failureClassification: classifyError,
    handler: NOOP_HANDLER,
  },

  "leads.qualify": {
    name: "leads.qualify",
    schemaVersion: 1,
    payloadSchema: leadsQualifyPayload,
    tenantScope: "tenant",
    timeout: 120000,
    retryLimit: 10,
    retryDelaySeconds: 5,
    enabled: true,
    idempotencyStrategy: "lead-status-check",
    failureClassification: classifyError,
    handler: NOOP_HANDLER,
  },

  "approvals.expire": {
    name: "approvals.expire",
    schemaVersion: 1,
    payloadSchema: approvalsExpirePayload,
    tenantScope: "tenant",
    timeout: 30000,
    retryLimit: 5,
    retryDelaySeconds: 5,
    enabled: true,
    idempotencyStrategy: "approval-status+version-guard",
    failureClassification: classifyError,
    handler: NOOP_HANDLER,
  },

  "approvals.deliver-result": {
    name: "approvals.deliver-result",
    schemaVersion: 1,
    payloadSchema: approvalsDeliverResultPayload,
    tenantScope: "tenant",
    timeout: 60000,
    retryLimit: 10,
    retryDelaySeconds: 5,
    enabled: true,
    idempotencyStrategy: "delivery-idempotency-key",
    failureClassification: classifyError,
    handler: NOOP_HANDLER,
  },

  "emails.send": {
    name: "emails.send",
    schemaVersion: 1,
    payloadSchema: emailsSendPayload,
    tenantScope: "tenant",
    timeout: 30000,
    retryLimit: 5,
    retryDelaySeconds: 5,
    enabled: true,
    idempotencyStrategy: "email-delivery-idempotency-key",
    failureClassification: classifyError,
    handler: NOOP_HANDLER,
  },

  "incidents.open-from-failure": {
    name: "incidents.open-from-failure",
    schemaVersion: 1,
    payloadSchema: incidentsOpenFromFailurePayload,
    tenantScope: "tenant",
    timeout: 30000,
    retryLimit: 3,
    retryDelaySeconds: 5,
    enabled: true,
    idempotencyStrategy: "incident-fingerprint-aggregation",
    failureClassification: defaultClassification,
    handler: NOOP_HANDLER,
  },

  "reports.generate-weekly": {
    name: "reports.generate-weekly",
    schemaVersion: 1,
    payloadSchema: reportsGenerateWeeklyPayload,
    tenantScope: "tenant",
    timeout: 60000,
    retryLimit: 3,
    retryDelaySeconds: 10,
    enabled: true,
    idempotencyStrategy: "snapshot-period+generation-version",
    failureClassification: defaultClassification,
    handler: NOOP_HANDLER,
  },

  "retention.prune-non-audit-data": {
    name: "retention.prune-non-audit-data",
    schemaVersion: 1,
    payloadSchema: retentionPrunePayload,
    tenantScope: "system",
    timeout: 300000,
    retryLimit: 2,
    retryDelaySeconds: 10,
    enabled: true,
    idempotencyStrategy: "dry-run-whitelist",
    failureClassification: defaultClassification,
    handler: NOOP_HANDLER,
  },
};

export const DISABLED_REASON = "disabled_pending_phase_6c";

export function getJob(name: string): JobDefinition | undefined {
  return JOB_DEFINITIONS[name];
}

export function isEnabled(name: string): boolean {
  const def = JOB_DEFINITIONS[name];
  return def?.enabled ?? false;
}

export function getDisabledJobs(): string[] {
  return Object.entries(JOB_DEFINITIONS)
    .filter(([, def]) => !def.enabled)
    .map(([name]) => name);
}
