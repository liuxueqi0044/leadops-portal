import type postgres from "postgres";
import type { Logger } from "pino";
import { processProjection, type ProjectionJob } from "../projector.js";

export async function handleEventsProject(
  _sql: postgres.Sql,
  logger: Logger,
  payload: { eventId: string; eventType: string; integrationId: string; organizationId: string; clientId: string },
): Promise<void> {
  const job: ProjectionJob = {
    eventId: payload.eventId,
    eventType: payload.eventType,
    integrationId: payload.integrationId,
    organizationId: payload.organizationId,
    clientId: payload.clientId,
  };

  await processProjection(logger, job, _sql);
}
