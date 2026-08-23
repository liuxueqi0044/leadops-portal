import type postgres from "postgres";
import type { Logger } from "pino";
import {
  claimApprovalDeliveryExact,
  markApprovalDeliveryDelivered,
  markApprovalDeliveryFailed,
  withIntegrationContext,
} from "@leadops/db";
import { deliverApprovalCallback, parseCallbackPayload } from "../approval-callback.js";
import { recordApprovalCallbackResult } from "@leadops/observability";

export async function handleApprovalsDeliverResult(
  sql: postgres.Sql,
  logger: Logger,
  payload: { deliveryId: string; organizationId: string; clientId: string; integrationId: string },
  workerId: string,
): Promise<void> {
  const binding = {
    organizationId: payload.organizationId,
    clientId: payload.clientId,
    integrationId: payload.integrationId,
  };
  const delivery = await withIntegrationContext(sql, binding, async (tx) =>
    claimApprovalDeliveryExact(tx as unknown as postgres.Sql, {
      ...binding,
      deliveryId: payload.deliveryId,
      workerId,
    }),
  );
  if (!delivery) {
    logger.info(
      { deliveryId: payload.deliveryId },
      "Delivery not found, already claimed, or not due",
    );
    return;
  }

  if (!delivery.callbackUrl) {
    await withIntegrationContext(sql, binding, async (tx) =>
      markApprovalDeliveryFailed(tx as unknown as postgres.Sql, delivery.id, workerId, "missing registered callback URL", false),
    );
    throw Object.assign(new Error("Missing callback URL"), { name: "PermanentDeliveryError" });
  }

  const parsed = parseCallbackPayload(delivery.payload);
  if (!parsed) {
    await withIntegrationContext(sql, binding, async (tx) =>
      markApprovalDeliveryFailed(tx as unknown as postgres.Sql, delivery.id, workerId, "invalid callback payload", false),
    );
    throw Object.assign(new Error("Invalid callback payload"), { name: "PermanentDeliveryError" });
  }

  const result = await deliverApprovalCallback(
    parsed,
    delivery.callbackUrl,
    delivery.secret ?? undefined,
    delivery.idempotencyKey,
    delivery.id,
  );

  if (result.success) {
    recordApprovalCallbackResult("success");
    await withIntegrationContext(sql, binding, async (tx) =>
      markApprovalDeliveryDelivered(tx as unknown as postgres.Sql, delivery.id, workerId),
    );
    logger.info({ deliveryId: delivery.id, event: "approval.delivered" }, "Approval delivery succeeded");
  } else if (result.retryable) {
    recordApprovalCallbackResult("failure");
    await withIntegrationContext(sql, binding, async (tx) =>
      markApprovalDeliveryFailed(tx as unknown as postgres.Sql, delivery.id, workerId, result.error ?? "callback failed", true),
    );
    logger.warn({ deliveryId: delivery.id, event: "approval.delivery_failed", retryable: true }, "Approval delivery retryable failure");
    throw Object.assign(new Error(result.error ?? "callback failed"), { name: "RetryableDeliveryError" });
  } else {
    recordApprovalCallbackResult("failure");
    await withIntegrationContext(sql, binding, async (tx) =>
      markApprovalDeliveryFailed(tx as unknown as postgres.Sql, delivery.id, workerId, result.error ?? "permanent failure", false),
    );
    logger.warn({ deliveryId: delivery.id, event: "approval.delivery_failed", retryable: false }, "Approval delivery permanent failure");
    throw Object.assign(new Error(result.error ?? "callback permanently failed"), { name: "PermanentDeliveryError" });
  }
}
