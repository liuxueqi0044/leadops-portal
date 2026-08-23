import type postgres from "postgres";
import type { Logger } from "pino";
import {
  getDefaultDatabase,
  upsertLeadAndInsertHistory,
  createAiRun,
  createOutboxMessage,
  withIntegrationContext,
} from "@leadops/db";
import {
  qualificationDecisionToStatus,
  normalizeEmail,
  normalizePhone,
  normalizeCompany,
  leadQualificationSchema,
  createLeadQualificationPrompt,
  runQualificationOrNeedsReview,
  canApplyQualificationDecision,
  type QualificationHandlerOptions,
} from "@leadops/core";
import type { LeadReceivedEvent, LeadQualifiedEvent } from "@leadops/events";
import type { QualificationProviderRegistration } from "./qualification-provider.js";

interface ProjectionBinding {
  integrationId: string;
  organizationId: string;
  clientId: string;
}

function getString(obj: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return null;
}

// The worker entry point must configure this explicitly. There is deliberately
// no fake fallback: production must never qualify real leads with test logic.
let qualificationProviderFactory: (() => QualificationProviderRegistration) | null = null;

export function setQualificationProviderFactory(
  factory: () => QualificationProviderRegistration,
): void {
  qualificationProviderFactory = factory;
}

export function resetQualificationProviderFactory(): void {
  qualificationProviderFactory = null;
}

export async function projectLeadReceived(
  sql: postgres.Sql,
  event: LeadReceivedEvent,
  binding: ProjectionBinding,
): Promise<void> {
  const leadData = (event.data as Record<string, unknown>).lead as Record<string, unknown> | undefined ?? {};
  const source = getString(leadData, "source") ?? event.source;
  const externalId = getString(leadData, "id", "externalId");
  const contactName = getString(leadData, "contactName", "name");
  const emailRaw = getString(leadData, "email");
  const phoneRaw = getString(leadData, "phone");
  const companyRaw = getString(leadData, "company");
  const message = getString(leadData, "message", "body");

  const result = await upsertLeadAndInsertHistory(sql, {
    organizationId: binding.organizationId,
    clientId: binding.clientId,
    source,
    externalId,
    contactName,
    email: normalizeEmail(emailRaw),
    phone: normalizePhone(phoneRaw),
    company: normalizeCompany(companyRaw),
    message,
    receivedAt: event.occurredAt,
  });

  if (result.isNew) {
    await createOutboxMessage(sql, {
      organizationId: binding.organizationId,
      integrationId: binding.integrationId,
      clientId: binding.clientId,
      aggregateType: "lead",
      aggregateId: result.id,
      messageType: "leads.qualify",
      payload: {
        schemaVersion: 1,
        leadId: result.id,
        organizationId: binding.organizationId,
        clientId: binding.clientId,
        integrationId: binding.integrationId,
        eventId: event.eventId,
      },
    });
  }
}

export async function projectLeadQualified(
  sql: postgres.Sql,
  event: LeadQualifiedEvent,
  binding: ProjectionBinding,
): Promise<void> {
  const externalLeadId = event.data.leadId;
  if (!externalLeadId) {
    throw new Error("lead.qualified event missing leadId");
  }

  // Resolve external lead ID to internal UUID via organizationId + clientId + source + externalId
  const resolvedRows = await sql.unsafe(
    `SELECT internal_id, current_status
     FROM lookup_lead_by_external(
       $1::uuid, $2::uuid, $3, $4
     )`,
    [binding.organizationId, binding.clientId, event.source, externalLeadId],
  );

  if (resolvedRows.length === 0) {
    throw new Error(
      `Lead not found: org=${binding.organizationId} client=${binding.clientId} source=${event.source} externalId=${externalLeadId}`,
    );
  }

  const resolved = resolvedRows[0] as Record<string, unknown>;
  const internalLeadId = resolved.internal_id as string;

  const qualification = event.data.qualification;
  if (!qualification) {
    throw new Error("lead.qualified event missing qualification data");
  }

  const reasons = Array.isArray(qualification.reasons) && qualification.reasons.length > 0
    ? qualification.reasons
    : [typeof qualification.summary === "string" ? qualification.summary : "No reasons provided"];

  const parsed = leadQualificationSchema.parse({
    schemaVersion: 1,
    score: qualification.score,
    decision: qualification.decision,
    reasons,
    summary: typeof qualification.summary === "string" ? qualification.summary : "",
    suggestedNextAction: typeof qualification.suggestedNextAction === "string"
      ? qualification.suggestedNextAction
      : "request_approval",
    confidence: typeof qualification.confidence === "number" ? qualification.confidence : 0.5,
    riskFlags: Array.isArray(qualification.riskFlags) ? qualification.riskFlags as string[] : [],
  });

  // Apply qualification data (non-state fields)
  await sql.unsafe(
    `UPDATE leads
     SET score = $4::integer,
         "qualificationDecision" = $5,
         "qualificationSummary" = $6,
         "qualificationConfidence" = $7::double precision,
         "suggestedNextAction" = $8,
         "qualifiedAt" = $9::timestamptz,
         "updatedAt" = now()
     WHERE id = $1::uuid
       AND "organizationId" = $2::uuid
       AND "clientId" = $3::uuid`,
    [
      internalLeadId, binding.organizationId, binding.clientId,
      parsed.score, parsed.decision, parsed.summary,
      parsed.confidence, parsed.suggestedNextAction,
      event.occurredAt,
    ],
  );

  // Atomic status transition + history
  const decision = qualificationDecisionToStatus[parsed.decision];
  const command = canApplyQualificationDecision("received", parsed.decision);

  await sql.unsafe(
    `SELECT apply_lead_status_atomic(
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7
     ) AS updated`,
    [internalLeadId, binding.organizationId, binding.clientId, command, decision, "system", "received"],
  );
}

export interface QualificationJobData {
  leadId: string;
  organizationId: string;
  clientId: string;
  integrationId: string;
  eventId?: string;
}

export async function processQualificationJob(
  logger: Logger,
  job: QualificationJobData,
  pool: postgres.Sql = getDefaultDatabase().sql,
): Promise<void> {
  // Step 1: Short transaction to read and validate lead via integration context
  const leadData = await withIntegrationContext(pool, {
    integrationId: job.integrationId,
    organizationId: job.organizationId,
    clientId: job.clientId,
  }, async (tx) => {
    const s = tx as unknown as postgres.Sql;
    const rows = await s.unsafe(
      `SELECT id, "contactName", email, phone, company, message, source, status
       FROM leads
       WHERE id = $1::uuid
         AND "organizationId" = $2::uuid
         AND "clientId" = $3::uuid`,
      [job.leadId, job.organizationId, job.clientId],
    );

    if (rows.length === 0) {
      logger.warn({ leadId: job.leadId }, "Lead not found for qualification");
      return null;
    }

    const lead = rows[0] as Record<string, unknown>;

    if (lead.status !== "received") {
      logger.info(
        { leadId: job.leadId, status: lead.status as string },
        "Lead not in received status, skipping qualification (idempotent)",
      );
      return null; // Idempotent: already processed
    }

    return {
      contactName: typeof lead.contactName === "string" ? lead.contactName : "",
      email: typeof lead.email === "string" ? lead.email : "",
      phone: typeof lead.phone === "string" ? lead.phone : "",
      company: typeof lead.company === "string" ? lead.company : "",
      message: typeof lead.message === "string" ? lead.message : "",
      source: typeof lead.source === "string" ? lead.source : "unknown",
    };
  });

  if (!leadData) return;

  // Step 2: Outside transaction, run the provider
  const prompt = createLeadQualificationPrompt();
  if (!qualificationProviderFactory) {
    throw new Error("Qualification provider is not configured");
  }
  const registration = qualificationProviderFactory();
  const provider = registration.provider;

  const options: QualificationHandlerOptions = {
    provider,
    prompt,
    providerName: registration.providerName,
    modelName: registration.modelName,
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 30_000,
    maxRetries: 2,
    maxInputLength: Number(process.env.AI_MAX_INPUT_LENGTH) || 10_000,
    maxCostCents: Number(process.env.AI_MAX_COST_CENTS) || 1000,
  };

  const { qualification, aiResult, needsReview } = await runQualificationOrNeedsReview(
    {
      contactName: leadData.contactName,
      email: leadData.email,
      phone: leadData.phone,
      company: leadData.company,
      message: leadData.message,
      source: leadData.source,
      serviceNeeded: "",
    },
    { leadId: job.leadId, organizationId: job.organizationId, clientId: job.clientId },
    options,
  );

  // Step 3: New transaction to atomically write all results
  await withIntegrationContext(pool, {
    integrationId: job.integrationId,
    organizationId: job.organizationId,
    clientId: job.clientId,
  }, async (tx) => {
    const s = tx as unknown as postgres.Sql;

    if (needsReview || !qualification) {
      await createAiRun(s, {
        organizationId: job.organizationId,
        clientId: job.clientId,
        leadId: job.leadId,
        provider: options.providerName,
        model: options.modelName,
        promptVersion: prompt.version,
        inputHash: aiResult.metadata.inputHash,
        result: null,
        tokens: aiResult.metadata.tokens
          ? { input: aiResult.metadata.tokens.input, output: aiResult.metadata.tokens.output }
          : null,
        cost: aiResult.metadata.cost
          ? {
              amountMinor: aiResult.metadata.cost.amountMinor,
              currency: aiResult.metadata.cost.currency,
            }
          : null,
        latencyMs: aiResult.metadata.latencyMs,
        status: aiResult.error?.code === "TIMEOUT" ? "timeout"
          : aiResult.error?.code === "BUDGET_EXCEEDED" ? "budget_exceeded"
          : "schema_error",
        errorClassification: aiResult.error?.code ?? "SCHEMA_VALIDATION_FAILED",
      });

      // Atomic status + history
      await s.unsafe(
        `SELECT apply_lead_status_atomic(
           $1::uuid, $2::uuid, $3::uuid, 'needs_review', 'needs_review', 'ai-qualifier', 'received'
         ) AS updated`,
        [job.leadId, job.organizationId, job.clientId],
      );
    } else {
      await createAiRun(s, {
        organizationId: job.organizationId,
        clientId: job.clientId,
        leadId: job.leadId,
        provider: options.providerName,
        model: options.modelName,
        promptVersion: prompt.version,
        inputHash: aiResult.metadata.inputHash,
        result: qualification,
        tokens: aiResult.metadata.tokens
          ? { input: aiResult.metadata.tokens.input, output: aiResult.metadata.tokens.output }
          : null,
        cost: aiResult.metadata.cost
          ? {
              amountMinor: aiResult.metadata.cost.amountMinor,
              currency: aiResult.metadata.cost.currency,
            }
          : null,
        latencyMs: aiResult.metadata.latencyMs,
        status: "completed",
        errorClassification: null,
      });

      // Apply qualification data
      await s.unsafe(
        `UPDATE leads
         SET score = $4::integer,
             "qualificationDecision" = $5,
             "qualificationSummary" = $6,
             "qualificationConfidence" = $7::double precision,
             "suggestedNextAction" = $8,
             "qualifiedAt" = now(),
             "updatedAt" = now()
         WHERE id = $1::uuid
           AND "organizationId" = $2::uuid
           AND "clientId" = $3::uuid`,
        [
          job.leadId, job.organizationId, job.clientId,
          qualification.score, qualification.decision, qualification.summary,
          qualification.confidence, qualification.suggestedNextAction,
        ],
      );

      // Atomic status transition
      const decision = qualificationDecisionToStatus[qualification.decision];
      const command = canApplyQualificationDecision("received", qualification.decision);

      await s.unsafe(
        `SELECT apply_lead_status_atomic(
           $1::uuid, $2::uuid, $3::uuid, $4, $5, 'ai-qualifier', 'received'
         ) AS updated`,
        [job.leadId, job.organizationId, job.clientId, command, decision],
      );
    }
  });
}
