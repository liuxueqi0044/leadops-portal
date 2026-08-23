import type postgres from "postgres";
import { withTenantContext } from "../tenancy/context.js";
import type { Actor } from "@leadops/core";
import {
  computeDedupeKey,
  leadCursorSchema,
  type LeadRecord,
  type AIRunRecord,
  type LeadQualification,
} from "@leadops/core";

export interface UpsertLeadFromEventParams {
  organizationId: string;
  clientId: string;
  source: string;
  externalId: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  message: string | null;
  receivedAt: string;
}

export interface UpsertLeadResult {
  id: string;
  organizationId: string;
  clientId: string;
  status: string;
  isNew: boolean;
}

export async function upsertLeadFromEvent(
  sql: postgres.Sql,
  params: UpsertLeadFromEventParams,
): Promise<UpsertLeadResult> {
  const dedupe = computeDedupeKey({
    email: params.email,
    phone: params.phone,
    source: params.source,
    externalId: params.externalId,
  });

  const rows = await sql.unsafe(
    `SELECT lid AS id, oid AS "organizationId", cid AS "clientId", st AS status, inew AS is_new
     FROM upsert_lead_dedupe(
       $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::integer,
       $7::text, $8::text, $9::text, $10::text, $11::text, $12::timestamptz
     )`,
    [
      params.organizationId,
      params.clientId,
      params.source,
      params.externalId,
      dedupe.key,
      dedupe.version,
      params.contactName,
      params.email,
      params.phone,
      params.company,
      params.message,
      params.receivedAt,
    ],
  );

  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    organizationId: row.organizationId as string,
    clientId: row.clientId as string,
    status: row.status as string,
    isNew: Boolean(row.is_new),
  };
}

export async function insertStatusHistory(
  sql: postgres.Sql,
  params: {
    leadId: string;
    organizationId: string;
    clientId: string;
    previousStatus: string | null;
    newStatus: string;
    command: string;
    performedBy?: string;
  },
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO lead_status_history (
       "leadId", "organizationId", "clientId",
       "previousStatus", "newStatus", "command", "performedBy"
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
    [
      params.leadId,
      params.organizationId,
      params.clientId,
      params.previousStatus,
      params.newStatus,
      params.command,
      params.performedBy ?? "system",
    ],
  );
}

export async function updateLeadStatus(
  sql: postgres.Sql,
  params: {
    leadId: string;
    organizationId: string;
    clientId: string;
    newStatus: string;
    command: string;
    performedBy?: string;
  },
): Promise<boolean> {
  const rows = await sql.unsafe(
    `SELECT apply_lead_status_atomic(
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, NULL
     ) AS updated`,
    [
      params.leadId,
      params.organizationId,
      params.clientId,
      params.command,
      params.newStatus,
      params.performedBy ?? "system",
    ],
  );
  return Boolean((rows[0] as Record<string, unknown>).updated);
}

export async function applyQualificationToLead(
  sql: postgres.Sql,
  params: {
    leadId: string;
    organizationId: string;
    clientId: string;
    score: number;
    decision: string;
    summary: string;
    confidence: number;
    suggestedNextAction: string | null;
    qualifiedAt: string;
    performedBy?: string;
  },
): Promise<boolean> {
  const rows = await sql.unsafe(
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
       AND "clientId" = $3::uuid
       AND status = 'received'
     RETURNING id`,
    [
      params.leadId,
      params.organizationId,
      params.clientId,
      params.score,
      params.decision,
      params.summary,
      params.confidence,
      params.suggestedNextAction,
      params.qualifiedAt,
    ],
  );
  return rows.length > 0;
}

export async function getLeadById(
  sql: postgres.Sql,
  params: {
    leadId: string;
    organizationId: string;
    clientId: string;
  },
): Promise<LeadRecord | null> {
  const rows = await sql.unsafe(
    `SELECT id, "organizationId", "clientId", source, "externalId",
            "dedupeKey", "dedupeVersion", status,
            "contactName", email, phone, company, message,
            score, "qualificationDecision", "qualificationSummary",
            "qualificationConfidence", "suggestedNextAction",
            metadata, "receivedAt", "qualifiedAt", "createdAt", "updatedAt"
     FROM leads
     WHERE id = $1::uuid
       AND "organizationId" = $2::uuid
       AND "clientId" = $3::uuid`,
    [params.leadId, params.organizationId, params.clientId],
  );
  if (rows.length === 0) return null;
  return mapLeadRow(rows[0] as Record<string, unknown>);
}

export interface ListLeadsParams {
  organizationId: string;
  clientId: string;
  cursor?: string | null;
  limit?: number;
  status?: string;
  minScore?: number;
  maxScore?: number;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface ListLeadsResult {
  items: LeadRecord[];
  nextCursor: string | null;
}

export async function listLeads(
  sql: postgres.Sql,
  params: ListLeadsParams,
): Promise<ListLeadsResult> {
  const limit = Math.min(params.limit ?? 20, 100);
  const conditions: string[] = [
    `"organizationId" = $1::uuid`,
    `"clientId" = $2::uuid`,
  ];
  const values: unknown[] = [params.organizationId, params.clientId];
  let paramIndex = 3;

  if (params.status) {
    values.push(params.status);
    conditions.push(`status = $${String(paramIndex)}`);
    paramIndex++;
  }
  if (params.minScore !== undefined) {
    values.push(params.minScore);
    conditions.push(`score >= $${String(paramIndex)}`);
    paramIndex++;
  }
  if (params.maxScore !== undefined) {
    values.push(params.maxScore);
    conditions.push(`score <= $${String(paramIndex)}`);
    paramIndex++;
  }
  if (params.source) {
    values.push(params.source);
    conditions.push(`source = $${String(paramIndex)}`);
    paramIndex++;
  }
  if (params.dateFrom) {
    values.push(params.dateFrom);
    conditions.push(`"receivedAt" >= $${String(paramIndex)}::timestamptz`);
    paramIndex++;
  }
  if (params.dateTo) {
    values.push(params.dateTo);
    conditions.push(`"receivedAt" <= $${String(paramIndex)}::timestamptz`);
    paramIndex++;
  }

  if (params.cursor) {
    const cursor = leadCursorSchema.parse(params.cursor);
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    const cursorReceivedAt = decoded.slice(0, separator);
    const cursorId = decoded.slice(separator + 1);
    values.push(cursorReceivedAt);
    values.push(cursorId);
    conditions.push(
      `("receivedAt", id) < ($${String(paramIndex)}::timestamptz, $${String(paramIndex + 1)}::uuid)`,
    );
    paramIndex += 2;
  }

  const whereClause = conditions.join(" AND ");
  const selectColumns = [
    `id`, `"organizationId"`, `"clientId"`, `source`, `"externalId"`,
    `"dedupeKey"`, `"dedupeVersion"`, `status`,
    `"contactName"`, `email`, `phone`, `company`, `message`,
    `score`, `"qualificationDecision"`, `"qualificationSummary"`,
    `"qualificationConfidence"`, `"suggestedNextAction"`,
    `metadata`, `"receivedAt"`, `"qualifiedAt"`, `"createdAt"`, `"updatedAt"`,
  ];

  const query = `
    SELECT ${selectColumns.join(", ")}
    FROM leads
    WHERE ${whereClause}
    ORDER BY "receivedAt" DESC, id DESC
    LIMIT $${String(paramIndex)}
  `;
  values.push(limit + 1);

  const rows = await sql.unsafe(query, values as Parameters<typeof sql.unsafe>[1]);

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1] as Record<string, unknown>;
    const cursorPayload = `${toIsoString(last.receivedAt)}|${String(last.id)}`;
    nextCursor = Buffer.from(cursorPayload).toString("base64url");
  }

  return {
    items: items.map((r) => mapLeadRow(r as Record<string, unknown>)),
    nextCursor,
  };
}

export async function createAiRun(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    clientId: string;
    leadId: string;
    provider: string;
    model: string;
    promptVersion: string;
    inputHash: string;
    result: Record<string, unknown> | null;
    tokens: Record<string, unknown> | null;
    cost: Record<string, unknown> | null;
    latencyMs: number;
    status: string;
    errorClassification: string | null;
  },
): Promise<AIRunRecord> {
  const rows = await sql.unsafe(
    `INSERT INTO ai_runs (
       "organizationId", "clientId", "leadId",
       provider, model, "promptVersion", "inputHash",
       result, tokens, cost, "latencyMs", status, "errorClassification"
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       $4, $5, $6, $7,
       $8::jsonb, $9::jsonb, $10::jsonb,
       $11, $12, $13
     )
     RETURNING id, "organizationId", "clientId", "leadId",
               provider, model, "promptVersion", "inputHash",
               result, tokens, cost, "latencyMs", status,
               "errorClassification", "createdAt"`,
    [
      params.organizationId,
      params.clientId,
      params.leadId,
      params.provider,
      params.model,
      params.promptVersion,
      params.inputHash,
      params.result ? JSON.stringify(params.result) : null,
      params.tokens ? JSON.stringify(params.tokens) : null,
      params.cost ? JSON.stringify(params.cost) : null,
      params.latencyMs,
      params.status,
      params.errorClassification,
    ],
  );

  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    organizationId: row.organizationId as string,
    clientId: row.clientId as string,
    leadId: row.leadId as string,
    provider: row.provider as string,
    model: row.model as string,
    promptVersion: row.promptVersion as string,
    inputHash: row.inputHash as string,
    result: row.result as LeadQualification | null,
    tokens: row.tokens as AIRunRecord["tokens"],
    cost: row.cost as AIRunRecord["cost"],
    latencyMs: Number(row.latencyMs),
    status: row.status as string,
    errorClassification: row.errorClassification as string | null,
    createdAt: row.createdAt as string,
  };
}

export async function getLeadStatusHistory(
  sql: postgres.Sql,
  params: {
    leadId: string;
    organizationId: string;
    clientId: string;
  },
): Promise<Record<string, unknown>[]> {
  const rows = await sql.unsafe(
    `SELECT id, "leadId", "previousStatus", "newStatus", "command",
            "performedBy", "createdAt"
     FROM lead_status_history
     WHERE "leadId" = $1::uuid
       AND "organizationId" = $2::uuid
       AND "clientId" = $3::uuid
     ORDER BY "createdAt" ASC`,
    [params.leadId, params.organizationId, params.clientId],
  );
  return rows.map((row) => ({
    ...(row as Record<string, unknown>),
    createdAt: toIsoString((row as Record<string, unknown>).createdAt),
  }));
}

function mapLeadRow(row: Record<string, unknown>): LeadRecord {
  return {
    id: row.id as string,
    organizationId: row.organizationId as string,
    clientId: row.clientId as string,
    source: row.source as string,
    externalId: (row.externalId as string) || null,
    dedupeKey: row.dedupeKey as string,
    dedupeVersion: Number(row.dedupeVersion),
    status: row.status as LeadRecord["status"],
    contactName: (row.contactName as string) || null,
    email: (row.email as string) || null,
    phone: (row.phone as string) || null,
    company: (row.company as string) || null,
    message: (row.message as string) || null,
    score: row.score != null ? Number(row.score) : null,
    qualificationDecision: (row.qualificationDecision as LeadRecord["qualificationDecision"]) ?? null,
    qualificationSummary: row.qualificationSummary as string | null ?? null,
    qualificationConfidence: row.qualificationConfidence != null ? Number(row.qualificationConfidence) : null,
    suggestedNextAction: row.suggestedNextAction as string | null ?? null,
    metadata: row.metadata as Record<string, unknown> | null ?? null,
    receivedAt: row.receivedAt == null ? null : toIsoString(row.receivedAt),
    qualifiedAt: row.qualifiedAt == null ? null : toIsoString(row.qualifiedAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString();
  }
  throw new Error("Database returned an invalid timestamp");
}

export interface DashboardMetrics {
  totalReceived: number;
  totalQualified: number;
  totalNeedsReview: number;
  totalApproved: number;
  totalRejected: number;
  totalConverted: number;
  totalArchived: number;
  qualificationRate: number | null;
  avgScore: number | null;
}

export async function getDashboardMetrics(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    clientId: string;
    dateFrom?: string;
    dateTo?: string;
  },
): Promise<DashboardMetrics> {
  const conditions: string[] = [
    `"organizationId" = $1::uuid`,
    `"clientId" = $2::uuid`,
  ];
  const values: unknown[] = [params.organizationId, params.clientId];
  let pi = 3;

  if (params.dateFrom) {
    values.push(params.dateFrom);
    conditions.push(`"receivedAt" >= $${String(pi)}::timestamptz`);
    pi++;
  }
  if (params.dateTo) {
    values.push(params.dateTo);
    conditions.push(`"receivedAt" <= $${String(pi)}::timestamptz`);
    pi++;
  }

  const where = conditions.join(" AND ");

  const rows = await sql.unsafe(
    `SELECT
       COUNT(*) AS "totalAll",
       COUNT(*) FILTER (WHERE status IS NOT NULL) AS "totalReceived",
       COUNT(*) FILTER (WHERE status IN ('qualified', 'approved', 'converted')) AS "totalQualified",
       COUNT(*) FILTER (WHERE status = 'needs_review') AS "totalNeedsReview",
       COUNT(*) FILTER (WHERE status = 'approved') AS "totalApproved",
       COUNT(*) FILTER (WHERE status = 'rejected') AS "totalRejected",
       COUNT(*) FILTER (WHERE status = 'converted') AS "totalConverted",
       COUNT(*) FILTER (WHERE status = 'archived') AS "totalArchived",
       ROUND(AVG(score) FILTER (WHERE score IS NOT NULL), 1) AS "avgScore"
     FROM leads
     WHERE ${where}`,
    values as Parameters<typeof sql.unsafe>[1],
  );

  const r = rows[0] as Record<string, unknown>;
  const totalAll = Number(r.totalAll ?? 0);
  const totalQualified = Number(r.totalQualified ?? 0);

  return {
    totalReceived: Number(r.totalReceived ?? 0),
    totalQualified,
    totalNeedsReview: Number(r.totalNeedsReview ?? 0),
    totalApproved: Number(r.totalApproved ?? 0),
    totalRejected: Number(r.totalRejected ?? 0),
    totalConverted: Number(r.totalConverted ?? 0),
    totalArchived: Number(r.totalArchived ?? 0),
    qualificationRate: totalAll > 0 ? totalQualified / totalAll : null,
    avgScore: r.avgScore != null ? Number(r.avgScore) : null,
  };
}

export async function getDashboardForTenant(
  pool: postgres.Sql,
  actor: Actor,
  params: {
    clientId: string;
    dateFrom?: string;
    dateTo?: string;
  },
): Promise<DashboardMetrics> {
  return withTenantContext(pool, actor, async (tx) => {
    return getDashboardMetrics(tx as unknown as postgres.Sql, {
      organizationId: actor.organizationId,
      clientId: params.clientId,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    });
  });
}

export async function getLeadForTenant(
  pool: postgres.Sql,
  actor: Actor,
  params: {
    clientId: string;
    leadId: string;
  },
): Promise<LeadRecord | null> {
  return withTenantContext(pool, actor, async (tx) => {
    return getLeadById(tx as unknown as postgres.Sql, {
      leadId: params.leadId,
      organizationId: actor.organizationId,
      clientId: params.clientId,
    });
  });
}

export async function listLeadsForTenant(
  pool: postgres.Sql,
  actor: Actor,
  params: Omit<ListLeadsParams, "organizationId">,
): Promise<ListLeadsResult> {
  return withTenantContext(pool, actor, async (tx) => {
    return listLeads(tx as unknown as postgres.Sql, {
      ...params,
      organizationId: actor.organizationId,
    });
  });
}

export async function upsertLeadAndInsertHistory(
  sql: postgres.Sql,
  params: UpsertLeadFromEventParams,
): Promise<UpsertLeadResult> {
  const result = await upsertLeadFromEvent(sql, params);

  if (result.isNew) {
    await insertStatusHistory(sql, {
      leadId: result.id,
      organizationId: result.organizationId,
      clientId: result.clientId,
      previousStatus: null,
      newStatus: "received",
      command: "lead.received",
    });
  }

  return result;
}
