import type postgres from "postgres";
import type { Logger } from "pino";
import { withIntegrationContext } from "@leadops/db";
import { normalizeFingerprint } from "@leadops/core";
import { recordIncidentAggregated, recordIncidentCreated } from "@leadops/observability";

function toPostgresSql(tx: unknown): postgres.Sql {
  return tx as postgres.Sql;
}

export async function handleIncidentsOpenFromFailure(
  sql: postgres.Sql,
  logger: Logger,
  payload: {
    organizationId: string;
    clientId: string;
    integrationId: string;
    occurrenceKey: string;
    workflowId?: string;
    jobName: string;
    errorCategory: string;
    errorName: string;
    errorMessage: string;
    attempt: number;
    retryLimit: number;
    correlationId?: string;
  },
): Promise<void> {
  const fingerprint = normalizeFingerprint({
    organizationId: payload.organizationId,
    clientId: payload.clientId,
    workflow: payload.workflowId ?? payload.jobName,
    category: payload.errorCategory,
    errorName: payload.errorName,
  });

  const category = payload.errorCategory;
  const severity = payload.attempt >= payload.retryLimit ? "critical" : "high";
  const errorSummary = `${payload.jobName}: ${payload.errorMessage}`.slice(0, 1000);

  await withIntegrationContext(
    sql,
    {
      integrationId: payload.integrationId,
      organizationId: payload.organizationId,
      clientId: payload.clientId,
    },
    async (tx) => {
      const txSql = toPostgresSql(tx);

      const result = await txSql.unsafe(
        `SELECT * FROM open_or_aggregate_incident(
           $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid,
           $6::text, $7::text, $8::text, $9::text,
           $10::text, $11::text
         )`,
        [
          payload.organizationId,
          payload.clientId,
          payload.integrationId,
          payload.occurrenceKey,
          payload.workflowId ?? null,
          fingerprint,
          category,
          severity,
          errorSummary,
          payload.jobName,
          payload.correlationId ?? null,
        ],
      );

      const row = result[0] as Record<string, unknown> | undefined;
      if (!row) {
        throw new Error("open_or_aggregate_incident returned no row");
      }

      if (row.isNew === true) recordIncidentCreated();
      else if (row.wasApplied === true) recordIncidentAggregated();

      logger.info(
        {
          event: "incident.aggregated",
          incidentId: row.id,
          fingerprint,
          isNew: row.isNew,
          wasApplied: row.wasApplied,
          occurrenceCount: row.occurrence_count ?? row.occurrenceCount,
          status: row.status,
        },
        `Incident ${row.isNew ? "created" : row.wasApplied ? "aggregated" : "replayed"}: ${fingerprint}`,
      );
    },
  );
}
