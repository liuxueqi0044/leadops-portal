import type postgres from "postgres";
import type { Logger } from "pino";
import type { EmailProvider, EmailSendResult } from "@leadops/email";
import { withIntegrationContext } from "@leadops/db";
import { recordEmailResult } from "@leadops/observability";

let emailProvider: EmailProvider | null = null;

export function setEmailProvider(provider: EmailProvider): void {
  emailProvider = provider;
}

export function getEmailProvider(): EmailProvider | null {
  return emailProvider;
}

export interface EmailDeliveryRow {
  id: string;
  organizationId: string;
  clientId: string;
  integrationId: string;
  idempotency_key: string;
  template_name: string;
  to_email: string;
  subject: string;
  html_body: string;
  text_body: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  provider_message_id: string | null;
  nextAttemptAt: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export async function handleEmailsSend(
  sql: postgres.Sql,
  logger: Logger,
  payload: { deliveryId: string; organizationId: string; clientId: string; integrationId: string },
  workerId: string,
  signal?: AbortSignal,
): Promise<void> {
  const provider = getEmailProvider();
  if (!provider) {
    throw Object.assign(
      new Error("Email provider is not configured"),
      { name: "EmailProviderNotConfigured", code: "PERMANENT" },
    );
  }

  const binding = {
    organizationId: payload.organizationId,
    clientId: payload.clientId,
    integrationId: payload.integrationId,
  };
  const delivery = await withIntegrationContext(
    sql,
    binding,
    async (tx) => claimEmailDelivery(
      tx as unknown as postgres.Sql,
      payload.deliveryId,
      payload.organizationId,
      payload.clientId,
      payload.integrationId,
      workerId,
    ),
  );
  if (!delivery) {
    logger.info(
      { deliveryId: payload.deliveryId },
      "Email delivery already claimed or not found",
    );
    return;
  }

  if (signal?.aborted) {
    throw Object.assign(new Error("Email send aborted before provider call"), { name: "AbortError" });
  }

  let sent: EmailSendResult;
  try {
    sent = await provider.send({
      to: delivery.to_email,
      subject: delivery.subject,
      htmlBody: delivery.html_body,
      textBody: delivery.text_body,
      idempotencyKey: delivery.idempotency_key,
      templateName: delivery.template_name,
      signal,
    });
  } catch (error) {
    recordEmailResult("failed");
    await withIntegrationContext(sql, binding, async (tx) =>
      markEmailDeliveryFailed(
        tx as unknown as postgres.Sql,
        delivery.id,
        payload.organizationId,
        payload.clientId,
        payload.integrationId,
        workerId,
        error instanceof Error ? error.message : "email provider failed",
        true,
      ),
    );
    throw error;
  }

  if (sent.ok) {
    recordEmailResult("sent");
    await withIntegrationContext(
      sql,
      binding,
      async (tx) => markEmailDeliverySent(
        tx as unknown as postgres.Sql,
        delivery.id,
        payload.organizationId,
        payload.clientId,
        payload.integrationId,
        workerId,
        sent.providerMessageId ?? null,
      ),
    );
    logger.info(
      { deliveryId: delivery.id, providerMessageId: sent.providerMessageId },
      "Email sent successfully",
    );
  } else if (sent.retryable) {
    recordEmailResult("failed");
    await withIntegrationContext(
      sql,
      binding,
      async (tx) => markEmailDeliveryFailed(
        tx as unknown as postgres.Sql,
        delivery.id,
        payload.organizationId,
        payload.clientId,
        payload.integrationId,
        workerId,
        sent.error ?? "send failed",
        true,
      ),
    );
    throw Object.assign(
      new Error(sent.error ?? "Email send failed"),
      { name: "RetryableEmailError", code: "RETRYABLE" },
    );
  } else {
    recordEmailResult("permanent_failure");
    await withIntegrationContext(
      sql,
      binding,
      async (tx) => markEmailDeliveryFailed(
        tx as unknown as postgres.Sql,
        delivery.id,
        payload.organizationId,
        payload.clientId,
        payload.integrationId,
        workerId,
        sent.error ?? "permanent failure",
        false,
      ),
    );
    throw Object.assign(
      new Error(sent.error ?? "Email send permanently failed"),
      { name: "PermanentEmailError", code: "PERMANENT" },
    );
  }
}

async function claimEmailDelivery(
  sql: postgres.Sql,
  deliveryId: string,
  organizationId: string,
  clientId: string,
  integrationId: string,
  workerId: string,
): Promise<EmailDeliveryRow | null> {
  const rows = await sql.unsafe(
    `SELECT * FROM claim_email_delivery($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)`,
    [deliveryId, organizationId, clientId, integrationId, workerId],
  );
  const row = rows[0] as EmailDeliveryRow | undefined;
  return row ?? null;
}

async function markEmailDeliverySent(
  sql: postgres.Sql,
  deliveryId: string,
  organizationId: string,
  clientId: string,
  integrationId: string,
  workerId: string,
  providerMessageId: string | null,
): Promise<boolean> {
  const rows = await sql.unsafe(
    'SELECT mark_email_delivery_sent($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6) AS updated',
    [deliveryId, organizationId, clientId, integrationId, workerId, providerMessageId],
  );
  return Boolean((rows[0] as Record<string, unknown> | undefined)?.updated);
}

async function markEmailDeliveryFailed(
  sql: postgres.Sql,
  deliveryId: string,
  organizationId: string,
  clientId: string,
  integrationId: string,
  workerId: string,
  error: string,
  retryable: boolean,
): Promise<boolean> {
  const rows = await sql.unsafe(
    'SELECT mark_email_delivery_failed($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7) AS updated',
    [deliveryId, organizationId, clientId, integrationId, workerId, error.slice(0, 2000), retryable],
  );
  return Boolean((rows[0] as Record<string, unknown> | undefined)?.updated);
}
