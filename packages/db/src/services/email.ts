import type postgres from "postgres";

export interface CreateEmailDeliveryParams {
  organizationId: string;
  clientId: string;
  integrationId: string;
  templateName: string;
  toEmail: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  idempotencyKey: string;
}

export interface CreateEmailDeliveryResult {
  id: string;
  organizationId: string;
  clientId: string;
  status: string;
  created: boolean;
}

export async function createEmailDelivery(
  sql: postgres.Sql,
  params: CreateEmailDeliveryParams,
): Promise<CreateEmailDeliveryResult> {
  const rows = await sql.unsafe(
    `SELECT id, oid AS "organizationId", cid AS "clientId", st AS status, created
     FROM create_email_delivery_idempotent(
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9
     )`,
    [
      params.organizationId,
      params.clientId,
      params.integrationId,
      params.templateName,
      params.toEmail,
      params.subject,
      params.htmlBody,
      params.textBody,
      params.idempotencyKey,
    ],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("email delivery insert returned no row");
  return {
    id: row.id as string,
    organizationId: row.organizationId as string,
    clientId: row.clientId as string,
    status: row.status as string,
    created: Boolean(row.created),
  };
}

export interface EmailDeliveryRow {
  id: string;
  organizationId: string;
  clientId: string;
  integrationId: string | null;
  template_name: string;
  to_email: string;
  subject: string;
  html_body: string;
  text_body: string;
  idempotency_key: string;
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

export async function getEmailDeliveryById(
  sql: postgres.Sql,
  deliveryId: string,
): Promise<EmailDeliveryRow | null> {
  const rows = await sql.unsafe(
    `SELECT * FROM email_deliveries WHERE id = $1::uuid`,
    [deliveryId],
  );
  const row = rows[0] as EmailDeliveryRow | undefined;
  return row ?? null;
}
