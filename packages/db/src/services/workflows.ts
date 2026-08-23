import type postgres from "postgres";

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

export interface WorkflowRow {
  id: string;
  organizationId: string;
  integrationId: string;
  clientId: string;
  externalId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunRow {
  id: string;
  organizationId: string;
  clientId: string;
  workflowId: string;
  externalRunId: string;
  status: string;
  startedAt: string | null;
  succeededAt: string | null;
  failedAt: string | null;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

const WORKFLOW_COLUMNS = `
  id, "organizationId", "integrationId", "clientId", "externalId",
  name, status, "createdAt", "updatedAt"
`;

const RUN_COLUMNS = `
  id, "organizationId", "clientId", "workflowId", "externalRunId",
  status, "startedAt", "succeededAt", "failedAt", error,
  "createdAt", "updatedAt"
`;

function normalizeWorkflowRunRow(row: WorkflowRunRow): WorkflowRunRow {
  return {
    ...row,
    startedAt: toNullableIsoString(row.startedAt),
    succeededAt: toNullableIsoString(row.succeededAt),
    failedAt: toNullableIsoString(row.failedAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

export async function upsertWorkflow(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    integrationId: string;
    clientId: string;
    externalId: string;
    name: string;
  },
): Promise<WorkflowRow> {
  const rows = await sql`
    INSERT INTO workflows (
      "organizationId", "integrationId", "clientId", "externalId", name
    )
    VALUES (
      ${params.organizationId}, ${params.integrationId}, ${params.clientId},
      ${params.externalId}, ${params.name}
    )
    ON CONFLICT ("integrationId", "externalId")
    DO UPDATE SET name = EXCLUDED.name, "updatedAt" = now()
    RETURNING ${sql.unsafe(WORKFLOW_COLUMNS)}
  `;
  return rows[0] as WorkflowRow;
}

export async function getWorkflowByExternalId(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    integrationId: string;
    clientId: string;
    externalId: string;
  },
): Promise<WorkflowRow | null> {
  const rows = await sql`
    SELECT ${sql.unsafe(WORKFLOW_COLUMNS)} FROM workflows
    WHERE "organizationId" = ${params.organizationId}
      AND "integrationId" = ${params.integrationId}
      AND "clientId" = ${params.clientId}
      AND "externalId" = ${params.externalId}
  `;
  return (rows[0] as WorkflowRow | undefined) ?? null;
}

export async function upsertWorkflowRun(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    clientId: string;
    workflowId: string;
    externalRunId: string;
    status: "started" | "succeeded" | "failed";
    startedAt?: string;
    succeededAt?: string;
    failedAt?: string;
    error?: Record<string, unknown>;
  },
): Promise<WorkflowRunRow> {
  const rows = await sql.unsafe(
    `INSERT INTO workflow_runs (
       "organizationId", "clientId", "workflowId", "externalRunId", status,
       "startedAt", "succeededAt", "failedAt", error
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6::timestamptz, $7::timestamptz, $8::timestamptz,
       (($9::jsonb #>> '{}')::jsonb)
     )
     ON CONFLICT ("workflowId", "externalRunId") DO UPDATE
     SET status = EXCLUDED.status,
         "updatedAt" = now(),
         "startedAt" = COALESCE(EXCLUDED."startedAt", workflow_runs."startedAt"),
         "succeededAt" = COALESCE(EXCLUDED."succeededAt", workflow_runs."succeededAt"),
         "failedAt" = COALESCE(EXCLUDED."failedAt", workflow_runs."failedAt"),
         error = COALESCE(EXCLUDED.error, workflow_runs.error)
     WHERE workflow_runs.status = 'started'
     RETURNING ${RUN_COLUMNS}`,
    [
      params.organizationId,
      params.clientId,
      params.workflowId,
      params.externalRunId,
      params.status,
      params.startedAt ?? null,
      params.succeededAt ?? null,
      params.failedAt ?? null,
      params.error ? JSON.stringify(params.error) : null,
    ],
  );

  if (rows[0]) return rows[0] as unknown as WorkflowRunRow;

  const existing = await getWorkflowRun(sql, {
    organizationId: params.organizationId,
    clientId: params.clientId,
    workflowId: params.workflowId,
    externalRunId: params.externalRunId,
  });
  if (!existing) throw new Error("Workflow run conflict did not return an existing row");
  return existing;
}

export async function getWorkflowRun(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    clientId: string;
    workflowId: string;
    externalRunId: string;
  },
): Promise<WorkflowRunRow | null> {
  const rows = await sql`
    SELECT ${sql.unsafe(RUN_COLUMNS)} FROM workflow_runs
    WHERE "organizationId" = ${params.organizationId}
      AND "clientId" = ${params.clientId}
      AND "workflowId" = ${params.workflowId}
      AND "externalRunId" = ${params.externalRunId}
  `;
  return (rows[0] as WorkflowRunRow | undefined) ?? null;
}

export interface ListWorkflowRunsParams {
  organizationId: string;
  clientId: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
  cursor?: string | null;
}

export interface ListWorkflowRunsResult {
  items: WorkflowRunRow[];
  nextCursor: string | null;
}

type SqlParam = string | number | boolean | null | Date;

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

export async function listWorkflowRunsForTenant(
  sql: postgres.Sql,
  params: ListWorkflowRunsParams,
): Promise<ListWorkflowRunsResult> {
  const limit = Math.min(params.limit, 100);

  const whereConditions: string[] = [`"organizationId" = $1`, `"clientId" = $2`];
  const whereValues: SqlParam[] = [params.organizationId, params.clientId];

  let placeholderIdx = 3;
  if (params.status) {
    whereConditions.push(`status = $${String(placeholderIdx)}`);
    whereValues.push(params.status);
    placeholderIdx += 1;
  }
  if (params.dateFrom) {
    whereConditions.push(`"createdAt" >= $${String(placeholderIdx)}::timestamptz`);
    whereValues.push(params.dateFrom);
    placeholderIdx += 1;
  }
  if (params.dateTo) {
    whereConditions.push(`"createdAt" < $${String(placeholderIdx)}::timestamptz`);
    whereValues.push(params.dateTo);
    placeholderIdx += 1;
  }

  let cursorClause = "";
  if (params.cursor) {
    try {
      const decoded = decodeCursor(params.cursor);
      cursorClause = ` AND ("createdAt" < $${String(placeholderIdx)}::timestamptz
         OR ("createdAt" = $${String(placeholderIdx)}::timestamptz AND id < $${String(placeholderIdx + 1)}::uuid))`;
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

  const rows = await sql.unsafe(
    `SELECT ${RUN_COLUMNS} FROM workflow_runs
     WHERE ${whereConditions.join(" AND ")}${cursorClause}
     ORDER BY "createdAt" DESC, id DESC
     LIMIT $${String(placeholderIdx)}`,
    allValues,
  ) as WorkflowRunRow[];

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(normalizeWorkflowRunRow);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = Buffer.from(
        `${last.createdAt}|${last.id}`,
        "utf8",
      ).toString("base64url");
    }
  }

  return { items, nextCursor };
}
