import type postgres from "postgres";
import type { Logger } from "pino";
import { processQualificationJob, type QualificationJobData } from "../lead-projectors.js";

export async function handleLeadsQualify(
  _sql: postgres.Sql,
  logger: Logger,
  payload: { leadId: string; organizationId: string; clientId: string; integrationId: string; eventId?: string },
): Promise<void> {
  const job: QualificationJobData = {
    leadId: payload.leadId,
    organizationId: payload.organizationId,
    clientId: payload.clientId,
    integrationId: payload.integrationId,
    eventId: payload.eventId,
  };

  await processQualificationJob(logger, job, _sql);
}
