import type postgres from "postgres";
import type { Logger } from "pino";
import {
  withIntegrationContext,
  computeClientPeriodMetrics,
  createReportSnapshot,
  type WeeklyMetrics,
} from "@leadops/db";
import { GENERATION_VERSION, weeklyMetricsSchema } from "@leadops/core";
import { recordReportGenerationResult } from "@leadops/observability";

function toPostgresSql(tx: unknown): postgres.Sql {
  return tx as postgres.Sql;
}

export async function handleReportsGenerateWeekly(
  sql: postgres.Sql,
  logger: Logger,
  payload: {
    organizationId: string;
    clientId: string;
    integrationId: string;
    periodStart: string;
    periodEnd: string;
    correlationId?: string;
  },
): Promise<void> {
  await withIntegrationContext(
    sql,
    {
      integrationId: payload.integrationId,
      organizationId: payload.organizationId,
      clientId: payload.clientId,
    },
    async (tx) => {
      const txSql = toPostgresSql(tx);

      const rawMetrics = await computeClientPeriodMetrics(txSql, {
        organizationId: payload.organizationId,
        clientId: payload.clientId,
        integrationId: payload.integrationId,
        periodStart: payload.periodStart,
        periodEnd: payload.periodEnd,
      });

      const totalLeads = rawMetrics.totalLeads || 0;
      const qualifiedLeads = rawMetrics.qualifiedLeads || 0;
      const approved = rawMetrics.approvedDecisions || 0;
      const rejected = rawMetrics.rejectedDecisions || 0;
      const totalDecisions = approved + rejected;

      const metrics: WeeklyMetrics = weeklyMetricsSchema.parse({
        leadsReceived: rawMetrics.leadsReceived,
        qualificationRate: totalLeads > 0 ? qualifiedLeads / totalLeads : 0,
        approvalConversion: totalDecisions > 0 ? approved / totalDecisions : 0,
        appointments: rawMetrics.appointments,
        workflowSuccess: rawMetrics.workflowSuccess,
        workflowFailure: rawMetrics.workflowFailure,
        openIncidents: rawMetrics.openIncidents,
        resolvedIncidents: rawMetrics.resolvedIncidents,
      });

      const result = await createReportSnapshot(txSql, {
        organizationId: payload.organizationId,
        clientId: payload.clientId,
        integrationId: payload.integrationId,
        periodStart: payload.periodStart,
        periodEnd: payload.periodEnd,
        generationVersion: GENERATION_VERSION,
        metrics,
        correlationId: payload.correlationId,
      });

      const eventName = result.created ? "report.snapshot_created" : "report.snapshot_idempotent";
      recordReportGenerationResult("success");

      logger.info(
        {
          event: eventName,
          snapshotId: result.id,
          organizationId: payload.organizationId,
          clientId: payload.clientId,
          periodStart: payload.periodStart,
          periodEnd: payload.periodEnd,
          created: result.created,
          metrics,
        },
        `Report snapshot ${result.created ? "created" : "already exists (idempotent)"} for ${payload.organizationId}/${payload.clientId}`,
      );
    },
  );
}
