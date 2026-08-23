import type postgres from "postgres";
import type { Logger } from "pino";
import {
  expireApprovalsForTenant,
  withIntegrationContext,
} from "@leadops/db";

export async function handleApprovalsExpire(
  sql: postgres.Sql,
  logger: Logger,
  payload: { organizationId: string; clientId: string; integrationId: string },
): Promise<void> {
  const rows = await withIntegrationContext(
    sql,
    payload,
    async (tx) => expireApprovalsForTenant(
      tx as unknown as postgres.Sql,
      payload.organizationId,
      payload.clientId,
      payload.integrationId,
    ),
  );

  if (rows.length > 0) {
    logger.info(
      { event: "approvals.expired", count: rows.length },
      `Expired ${String(rows.length)} approvals`,
    );
  }
}
