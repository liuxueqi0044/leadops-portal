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

export interface ReportSnapshotRow {
  id: string;
  organizationId: string;
  clientId: string;
  integrationId: string;
  periodStart: string;
  periodEnd: string;
  generationVersion: number;
  metrics: WeeklyMetrics;
  correlationId: string | null;
  generatedAt: string;
  createdAt: string;
}

export interface WeeklyMetrics {
  leadsReceived: number;
  qualificationRate: number;
  approvalConversion: number;
  appointments: number;
  workflowSuccess: number;
  workflowFailure: number;
  openIncidents: number;
  resolvedIncidents: number;
}

const SNAPSHOT_COLUMNS = `
  id, "organizationId", "clientId", "integrationId",
  "periodStart", "periodEnd", "generationVersion",
  metrics, "correlationId", "generatedAt", "createdAt"
`;

function normalizeSnapshotRow(row: ReportSnapshotRow): ReportSnapshotRow {
  return {
    ...row,
    periodStart: toIsoString(row.periodStart),
    periodEnd: toIsoString(row.periodEnd),
    generatedAt: toIsoString(row.generatedAt),
    createdAt: toIsoString(row.createdAt),
  };
}

export interface CreateSnapshotResult {
  id: string;
  organizationId: string;
  clientId: string;
  periodStart: string;
  periodEnd: string;
  generationVersion: number;
  metrics: WeeklyMetrics;
  generatedAt: string;
  created: boolean;
}

export async function createReportSnapshot(
  tx: postgres.Sql,
  params: {
    organizationId: string;
    clientId: string;
    integrationId: string;
    periodStart: string;
    periodEnd: string;
    generationVersion: number;
    metrics: WeeklyMetrics;
    correlationId?: string;
  },
): Promise<CreateSnapshotResult> {
  const metricsJson = JSON.stringify(params.metrics);

  const rows = await tx.unsafe(
    `SELECT * FROM create_report_snapshot_idempotent(
       $1::uuid, $2::uuid, $3::uuid,
       $4::timestamptz, $5::timestamptz,
       $6::integer, ($7::text)::jsonb, $8::text
     )`,
    [
      params.organizationId,
      params.clientId,
      params.integrationId,
      params.periodStart,
      params.periodEnd,
      params.generationVersion,
      metricsJson,
      params.correlationId ?? null,
    ],
  ) as Record<string, unknown>[];

  if (!rows[0]) throw new Error("create_report_snapshot_idempotent returned no row");

  const r = rows[0];
  return {
    id: String(r.id),
    organizationId: String(r.organizationId),
    clientId: String(r.clientId),
    periodStart: toIsoString(r.periodStart),
    periodEnd: toIsoString(r.periodEnd),
    generationVersion: Number(r.generationVersion),
    metrics: r.metrics as WeeklyMetrics,
    generatedAt: toIsoString(r.generatedAt),
    created: Boolean(r.created),
  };
}

export async function getReportSnapshotForTenant(
  tx: postgres.Sql,
  params: {
    organizationId: string;
    snapshotId: string;
  },
): Promise<ReportSnapshotRow | null> {
  const rows = await tx.unsafe(
    `SELECT ${SNAPSHOT_COLUMNS} FROM report_snapshots
     WHERE id = $1
       AND "organizationId" = $2`,
    [params.snapshotId, params.organizationId],
  ) as ReportSnapshotRow[];
  return rows[0] ? normalizeSnapshotRow(rows[0]) : null;
}

export interface ListSnapshotsParams {
  organizationId: string;
  clientId: string;
  limit: number;
  dateFrom?: string;
  dateTo?: string;
  cursor?: string | null;
}

export interface ListSnapshotsResult {
  items: ReportSnapshotRow[];
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

export async function listReportSnapshotsForTenant(
  tx: postgres.Sql,
  params: ListSnapshotsParams,
): Promise<ListSnapshotsResult> {
  const limit = Math.min(params.limit, 100);

  const whereConditions: string[] = [`"organizationId" = $1`, `"clientId" = $2`];
  const whereValues: SqlParam[] = [params.organizationId, params.clientId];

  let placeholderIdx = 3;
  if (params.dateFrom) {
    whereConditions.push(`"periodStart" >= $${String(placeholderIdx)}::timestamptz`);
    whereValues.push(params.dateFrom);
    placeholderIdx += 1;
  }
  if (params.dateTo) {
    whereConditions.push(`"periodEnd" <= $${String(placeholderIdx)}::timestamptz`);
    whereValues.push(params.dateTo);
    placeholderIdx += 1;
  }

  let cursorClause = "";
  if (params.cursor) {
    try {
      const decoded = decodeCursor(params.cursor);
      cursorClause = ` AND ("periodStart" < $${String(placeholderIdx)}::timestamptz
         OR ("periodStart" = $${String(placeholderIdx)}::timestamptz AND id < $${String(placeholderIdx + 1)}::uuid))`;
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
    `SELECT ${SNAPSHOT_COLUMNS} FROM report_snapshots
     WHERE ${whereConditions.join(" AND ")}${cursorClause}
     ORDER BY "periodStart" DESC, id DESC
     LIMIT $${String(placeholderIdx)}`,
    allValues,
  ) as ReportSnapshotRow[];

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(normalizeSnapshotRow);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = Buffer.from(
        `${last.periodStart}|${last.id}`,
        "utf8",
      ).toString("base64url");
    }
  }

  return { items, nextCursor };
}

export interface ClientPeriodMetrics {
  leadsReceived: number;
  qualifiedLeads: number;
  totalLeads: number;
  approvals: number;
  approvedDecisions: number;
  rejectedDecisions: number;
  appointments: number;
  workflowSuccess: number;
  workflowFailure: number;
  openIncidents: number;
  resolvedIncidents: number;
}

export async function computeClientPeriodMetrics(
  tx: postgres.Sql,
  params: {
    organizationId: string;
    clientId: string;
    integrationId: string;
    periodStart: string;
    periodEnd: string;
  },
): Promise<ClientPeriodMetrics> {
  const rows = await tx.unsafe(
    `SELECT * FROM compute_weekly_report_metrics(
       $1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz
     )`,
    [
      params.organizationId,
      params.clientId,
      params.integrationId,
      params.periodStart,
      params.periodEnd,
    ],
  ) as ClientPeriodMetrics[];

  return rows[0] ?? {
    leadsReceived: 0,
    qualifiedLeads: 0,
    totalLeads: 0,
    approvals: 0,
    approvedDecisions: 0,
    rejectedDecisions: 0,
    appointments: 0,
    workflowSuccess: 0,
    workflowFailure: 0,
    openIncidents: 0,
    resolvedIncidents: 0,
  };
}

export interface OperationsDashboardResult {
  leadsReceived: number;
  qualificationRate: number;
  approvalConversion: number;
  appointments: number;
  workflowSuccess: number;
  workflowFailure: number;
  openIncidents: number;
  resolvedIncidents: number;
  totalLeads: number;
  totalQualified: number;
  totalApproved: number;
  totalRejected: number;
  avgScore: number | null;
}

export async function computeOperationsDashboard(
  tx: postgres.Sql,
  params: {
    organizationId: string;
    clientId: string;
    dateFrom?: string;
    dateTo?: string;
  },
): Promise<OperationsDashboardResult> {
  const dateFrom = params.dateFrom ?? "1970-01-01T00:00:00.000Z";
  const dateTo = params.dateTo ?? "9999-12-31T23:59:59.999Z";

  const rows = await tx.unsafe(
    `WITH lead_stats AS (
       SELECT
          COALESCE(COUNT(*), 0)::int AS leads_received,
         COALESCE(COUNT(*) FILTER (WHERE l.status IN ('qualified', 'approved', 'converted')), 0)::int AS qualified_leads,
         COALESCE(COUNT(*), 0)::int AS total_leads,
         COALESCE(AVG(l.score) FILTER (WHERE l.score IS NOT NULL), 0)::float AS avg_score
       FROM leads l
       WHERE l."organizationId" = $1
         AND l."clientId" = $2
          AND COALESCE(l."receivedAt", l."createdAt") >= $3::timestamptz
          AND COALESCE(l."receivedAt", l."createdAt") < $4::timestamptz
     ),
     appt_stats AS (
       SELECT COALESCE(COUNT(*), 0)::int AS appointments
       FROM business_events e
       WHERE e."organizationId" = $1
         AND e."clientId" = $2
         AND e."eventType" = 'appointment.booked'
         AND e."receivedAt" >= $3::timestamptz
         AND e."receivedAt" < $4::timestamptz
     ),
     approval_stats AS (
       SELECT
         COALESCE(COUNT(*) FILTER (WHERE ap.status = 'approved'), 0)::int AS approved,
         COALESCE(COUNT(*) FILTER (WHERE ap.status = 'rejected'), 0)::int AS rejected
       FROM approvals ap
       WHERE ap."organizationId" = $1
         AND ap."clientId" = $2
         AND ap.decided_at >= $3::timestamptz
         AND ap.decided_at < $4::timestamptz
     ),
     wf_stats AS (
       SELECT
         COALESCE(COUNT(*) FILTER (
           WHERE wr.status = 'succeeded'
             AND wr."succeededAt" >= $3::timestamptz
             AND wr."succeededAt" < $4::timestamptz
         ), 0)::int AS workflow_success,
         COALESCE(COUNT(*) FILTER (
           WHERE wr.status = 'failed'
             AND wr."failedAt" >= $3::timestamptz
             AND wr."failedAt" < $4::timestamptz
         ), 0)::int AS workflow_failure
       FROM workflow_runs wr
       WHERE wr."organizationId" = $1
         AND wr."clientId" = $2
     ),
     incident_stats AS (
       SELECT
         COALESCE(COUNT(*) FILTER (
           WHERE i.status <> 'resolved' AND i."firstSeenAt" < $4::timestamptz
         ), 0)::int AS open_incidents,
         COALESCE(COUNT(*) FILTER (
           WHERE i."resolvedAt" >= $3::timestamptz
             AND i."resolvedAt" < $4::timestamptz
         ), 0)::int AS resolved_incidents
       FROM incidents i
       WHERE i."organizationId" = $1
         AND i."clientId" = $2
     )
     SELECT
       ls.leads_received AS "leadsReceived",
       CASE WHEN ls.total_leads > 0 THEN ls.qualified_leads::float / ls.total_leads ELSE 0 END AS "qualificationRate",
       CASE WHEN aps.approved + aps.rejected > 0 THEN aps.approved::float / (aps.approved + aps.rejected) ELSE 0 END AS "approvalConversion",
       COALESCE(apts.appointments, 0) AS "appointments",
       COALESCE(wfs.workflow_success, 0) AS "workflowSuccess",
       COALESCE(wfs.workflow_failure, 0) AS "workflowFailure",
       COALESCE(ins.open_incidents, 0) AS "openIncidents",
       COALESCE(ins.resolved_incidents, 0) AS "resolvedIncidents",
       ls.total_leads AS "totalLeads",
       ls.qualified_leads AS "totalQualified",
       COALESCE(aps.approved, 0) AS "totalApproved",
       COALESCE(aps.rejected, 0) AS "totalRejected",
       CASE WHEN ls.avg_score > 0 THEN ls.avg_score ELSE NULL END AS "avgScore"
     FROM lead_stats ls
     CROSS JOIN appt_stats apts
     CROSS JOIN approval_stats aps
     CROSS JOIN wf_stats wfs
     CROSS JOIN incident_stats ins`,
    [params.organizationId, params.clientId, dateFrom, dateTo],
  ) as OperationsDashboardResult[];

  const r = rows[0];
  return r ?? {
    leadsReceived: 0,
    qualificationRate: 0,
    approvalConversion: 0,
    appointments: 0,
    workflowSuccess: 0,
    workflowFailure: 0,
    openIncidents: 0,
    resolvedIncidents: 0,
    totalLeads: 0,
    totalQualified: 0,
    totalApproved: 0,
    totalRejected: 0,
    avgScore: null,
  };
}
