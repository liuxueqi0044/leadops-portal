import type postgres from "postgres";

type SqlParam = string | number | boolean | null | Date;

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString();
  }
  throw new TypeError("expected a database timestamp");
}

function toNullableIsoString(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoString(value);
}

export interface IncidentRow {
  id: string;
  organizationId: string;
  clientId: string;
  integrationId: string;
  workflowId: string | null;
  fingerprint: string;
  category: string;
  severity: string;
  status: string;
  occurrenceCount: number;
  errorSummary: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentEventRow {
  id: string;
  organizationId: string;
  clientId: string;
  incidentId: string;
  occurrenceKey: string | null;
  eventType: string;
  actor: string | null;
  correlationId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const INCIDENT_COLUMNS = `
  id, "organizationId", "clientId", "integrationId", "workflowId",
  fingerprint, category, severity, status, "occurrenceCount",
  error_summary AS "errorSummary",
  "firstSeenAt", "lastSeenAt",
  "acknowledgedAt", "acknowledgedBy", "resolvedAt", "resolvedBy",
  "createdAt", "updatedAt"
`;

const EVENT_COLUMNS = `
  id, "organizationId", "clientId", "incidentId", "occurrenceKey",
  event_type AS "eventType", actor, "correlationId",
  metadata, "createdAt"
`;

function normalizeIncidentRow(row: IncidentRow): IncidentRow {
  return {
    ...row,
    firstSeenAt: toIsoString(row.firstSeenAt),
    lastSeenAt: toIsoString(row.lastSeenAt),
    acknowledgedAt: toNullableIsoString(row.acknowledgedAt),
    resolvedAt: toNullableIsoString(row.resolvedAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function normalizeIncidentEventRow(row: IncidentEventRow): IncidentEventRow {
  return { ...row, createdAt: toIsoString(row.createdAt) };
}

export interface OpenAggregateResult {
  id: string;
  organizationId: string;
  clientId: string;
  fingerprint: string;
  status: string;
  occurrenceCount: number;
  lastSeenAt: string;
  isNew: boolean;
  wasApplied: boolean;
}

export async function openOrAggregateIncident(
  tx: postgres.Sql,
  params: {
    organizationId: string;
    clientId: string;
    integrationId: string;
    occurrenceKey: string;
    workflowId?: string;
    fingerprint: string;
    category: string;
    severity?: string;
    errorSummary?: string;
    jobName?: string;
    correlationId?: string;
  },
): Promise<OpenAggregateResult> {
  const rows = await tx.unsafe(
    `SELECT * FROM open_or_aggregate_incident(
       $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid,
       $6::text, $7::text, $8::text, $9::text,
       $10::text, $11::text
     )`,
    [
      params.organizationId,
      params.clientId,
      params.integrationId,
      params.occurrenceKey,
      params.workflowId ?? null,
      params.fingerprint,
      params.category,
      params.severity ?? "medium",
      params.errorSummary ?? null,
      params.jobName ?? null,
      params.correlationId ?? null,
    ] as SqlParam[],
  ) as OpenAggregateResult[];

  if (!rows[0]) throw new Error("open_or_aggregate_incident returned no row");
  return rows[0];
}

export async function getIncidentForTenant(
  tx: postgres.Sql,
  params: {
    organizationId: string;
    incidentId: string;
  },
): Promise<IncidentRow | null> {
  const rows = await tx.unsafe(
    `SELECT ${INCIDENT_COLUMNS} FROM incidents
     WHERE id = $1
       AND "organizationId" = $2`,
    [params.incidentId, params.organizationId],
  ) as IncidentRow[];
  return rows[0] ? normalizeIncidentRow(rows[0]) : null;
}

export interface ListIncidentsParams {
  organizationId: string;
  clientId: string;
  status?: string;
  severity?: string;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
  cursor?: string | null;
}

export interface ListIncidentsResult {
  items: IncidentRow[];
  nextCursor: string | null;
}

function decodeCursor(
  cursor: string,
): { sortValue: string; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator <= 0) {
    throw Object.assign(new Error("invalid cursor"), { code: "INVALID", httpStatus: 400 });
  }
  return {
    sortValue: decoded.slice(0, separator),
    id: decoded.slice(separator + 1),
  };
}

export async function listIncidentsForTenant(
  tx: postgres.Sql,
  params: ListIncidentsParams,
): Promise<ListIncidentsResult> {
  const limit = Math.min(params.limit, 100);

  const whereConditions: string[] = [`"organizationId" = $1`, `"clientId" = $2`];
  const whereValues: SqlParam[] = [params.organizationId, params.clientId];

  let placeholderIdx = 3;
  if (params.status) {
    whereConditions.push(`status = $${String(placeholderIdx)}`);
    whereValues.push(params.status);
    placeholderIdx += 1;
  }
  if (params.severity) {
    whereConditions.push(`severity = $${String(placeholderIdx)}`);
    whereValues.push(params.severity);
    placeholderIdx += 1;
  }
  if (params.dateFrom) {
    whereConditions.push(`"lastSeenAt" >= $${String(placeholderIdx)}::timestamptz`);
    whereValues.push(params.dateFrom);
    placeholderIdx += 1;
  }
  if (params.dateTo) {
    whereConditions.push(`"lastSeenAt" < $${String(placeholderIdx)}::timestamptz`);
    whereValues.push(params.dateTo);
    placeholderIdx += 1;
  }

  let cursorClause = "";
  if (params.cursor) {
    try {
      const decoded = decodeCursor(params.cursor);
      cursorClause = ` AND ("lastSeenAt" < $${String(placeholderIdx)}::timestamptz
         OR ("lastSeenAt" = $${String(placeholderIdx)}::timestamptz AND id < $${String(placeholderIdx + 1)}::uuid))`;
      whereValues.push(decoded.sortValue, decoded.id);
      placeholderIdx += 2;
    } catch (e: unknown) {
      if (e instanceof Error && 'code' in e && (e as Record<string, unknown>).code === "INVALID") {
        throw e;
      }
      throw Object.assign(new Error("invalid cursor"), { code: "INVALID", httpStatus: 400 });
    }
  }

  const allValues: SqlParam[] = [...whereValues, limit + 1];

  const rows = await tx.unsafe(
    `SELECT ${INCIDENT_COLUMNS} FROM incidents
     WHERE ${whereConditions.join(" AND ")}${cursorClause}
     ORDER BY "lastSeenAt" DESC, id DESC
     LIMIT $${String(placeholderIdx)}`,
    allValues,
  ) as IncidentRow[];

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(normalizeIncidentRow);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = Buffer.from(
        `${last.lastSeenAt}|${last.id}`,
        "utf8",
      ).toString("base64url");
    }
  }

  return { items, nextCursor };
}

export async function getIncidentEvents(
  tx: postgres.Sql,
  params: {
    organizationId: string;
    incidentId: string;
  },
): Promise<IncidentEventRow[]> {
  const rows = await tx.unsafe(
    `SELECT ${EVENT_COLUMNS} FROM incident_events
     WHERE "incidentId" = $1
       AND "organizationId" = $2
     ORDER BY "createdAt" ASC`,
    [params.incidentId, params.organizationId],
  ) as IncidentEventRow[];
  return rows.map(normalizeIncidentEventRow);
}

export async function acknowledgeIncidentForTenant(
  tx: postgres.Sql,
  params: {
    incidentId: string;
    organizationId: string;
    actor: string;
    expectedStatus: string;
    correlationId: string;
  },
): Promise<{ id: string; status: string; acknowledgedAt: string; acknowledgedBy: string; updatedAt: string }> {
  const rows = await tx.unsafe(
    `SELECT * FROM acknowledge_incident($1::uuid, $2::uuid, $3::text, $4::text, $5::text)`,
    [params.incidentId, params.organizationId, params.actor, params.expectedStatus, params.correlationId] as SqlParam[],
  );
  if (!rows[0]) throw Object.assign(new Error("incident not found"), { code: "NOT_FOUND", httpStatus: 404 });
  const r = rows[0] as Record<string, unknown>;
  return {
    id: String(r.id),
    status: String(r.status),
    acknowledgedAt: toIsoString(r.acknowledgedAt),
    acknowledgedBy: String(r.acknowledgedBy),
    updatedAt: toIsoString(r.updatedAt),
  };
}

export async function resolveIncidentForTenant(
  tx: postgres.Sql,
  params: {
    incidentId: string;
    organizationId: string;
    actor: string;
    expectedStatus: string;
    correlationId: string;
  },
): Promise<{ id: string; status: string; resolvedAt: string; resolvedBy: string; updatedAt: string }> {
  const rows = await tx.unsafe(
    `SELECT * FROM resolve_incident($1::uuid, $2::uuid, $3::text, $4::text, $5::text)`,
    [params.incidentId, params.organizationId, params.actor, params.expectedStatus, params.correlationId] as SqlParam[],
  );
  if (!rows[0]) throw Object.assign(new Error("incident not found"), { code: "NOT_FOUND", httpStatus: 404 });
  const r = rows[0] as Record<string, unknown>;
  return {
    id: String(r.id),
    status: String(r.status),
    resolvedAt: toIsoString(r.resolvedAt),
    resolvedBy: String(r.resolvedBy),
    updatedAt: toIsoString(r.updatedAt),
  };
}

export interface IncidentCountResult {
  openIncidents: number;
  resolvedIncidents: number;
}

export async function getIncidentCountsForPeriod(
  tx: postgres.Sql,
  params: {
    organizationId: string;
    clientId: string;
    periodStart: string;
    periodEnd: string;
  },
): Promise<IncidentCountResult> {
  const rows = await tx.unsafe(
    `SELECT
       COALESCE(SUM(CASE WHEN i.status = 'open' THEN 1 ELSE 0 END), 0)::int AS "openIncidents",
       COALESCE(SUM(CASE WHEN i.status = 'resolved' THEN 1 ELSE 0 END), 0)::int AS "resolvedIncidents"
     FROM incidents i
     WHERE i."organizationId" = $1
       AND i."clientId" = $2
       AND i."lastSeenAt" >= $3::timestamptz
       AND i."lastSeenAt" < $4::timestamptz`,
    [params.organizationId, params.clientId, params.periodStart, params.periodEnd],
  ) as IncidentCountResult[];
  return rows[0] ?? { openIncidents: 0, resolvedIncidents: 0 };
}
