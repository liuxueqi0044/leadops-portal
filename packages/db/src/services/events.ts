import type postgres from "postgres";
import { withTenantContext } from "../tenancy/context.js";
import type { Actor } from "@leadops/core";

interface BusinessEventRow {
  id: string;
  integrationId: string;
  organizationId: string;
  clientId: string;
  webhookId: string;
  eventType: string;
  rawJson: Record<string, unknown>;
  bodyHash: string;
  status: string;
  errorMessage: string | null;
  receivedAt: string;
  projectedAt: string | null;
}

interface OutboxRow {
  id: string;
  organizationId: string;
  integrationId: string;
  clientId: string;
  aggregateType: string;
  aggregateId: string;
  messageType: string;
  payload: Record<string, unknown>;
  status: string;
  lockedAt: string | null;
  lockedBy: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

const BE_COLUMNS_ALIASED = [
  "id", "\"integrationId\"", "\"organizationId\"", "\"clientId\"",
  "\"webhookId\"", "\"eventType\"",
  "raw_json AS \"rawJson\"",
  "body_hash AS \"bodyHash\"",
  "status", "error_message AS \"errorMessage\"",
  "\"receivedAt\"", "\"projectedAt\""
];

const BE_SELECT = BE_COLUMNS_ALIASED.join(", ");

function mapBusinessEvent(row: Record<string, unknown>): BusinessEventRow {
  return {
    id: row.id as string,
    integrationId: row.integrationId as string,
    organizationId: row.organizationId as string,
    clientId: row.clientId as string,
    webhookId: row.webhookId as string,
    eventType: row.eventType as string,
    rawJson: row.rawJson as Record<string, unknown>,
    bodyHash: row.bodyHash as string,
    status: row.status as string,
    errorMessage: (row.errorMessage as string) || null,
    receivedAt: row.receivedAt as string,
    projectedAt: (row.projectedAt as string) || null,
  };
}

function mapOutboxRow(r: Record<string, unknown>): OutboxRow {
  return {
    id: r.id as string,
    organizationId: r.organizationId as string,
    integrationId: r.integrationId as string,
    clientId: r.clientId as string,
    aggregateType: r.aggregateType as string,
    aggregateId: r.aggregateId as string,
    messageType: r.messageType as string,
    payload: r.payload as Record<string, unknown>,
    status: r.status as string,
    lockedAt: (r.lockedAt as string) || null,
    lockedBy: (r.lockedBy as string) || null,
    attemptCount: Number(r.attemptCount ?? 0),
    maxAttempts: Number(r.maxAttempts ?? 10),
    nextAttemptAt: (r.nextAttemptAt as string) || null,
    lastError: (r.lastError as string) || null,
    deliveredAt: (r.deliveredAt as string) || null,
    createdAt: r.createdAt as string,
  };
}

export interface ReceiveEventParams {
  integrationId: string;
  organizationId: string;
  clientId: string;
  webhookId: string;
  eventType: string;
  rawJson: Record<string, unknown>;
  bodyHash: string;
}

export interface ReceiveEventResult {
  businessEvent: BusinessEventRow;
  isDuplicate: boolean;
  bodyMismatch: boolean;
}

export async function receiveBusinessEvent(
  sql: postgres.Sql,
  params: ReceiveEventParams,
): Promise<ReceiveEventResult> {
  const rows = await sql.unsafe(
    `INSERT INTO business_events (
       "integrationId", "organizationId", "clientId",
       "webhookId", "eventType", raw_json, body_hash
     )
     VALUES ($1, $2, $3, $4, $5, (($6::jsonb #>> '{}')::jsonb), $7)
     ON CONFLICT ("integrationId", "webhookId") DO NOTHING
     RETURNING ${BE_SELECT}`,
    [
      params.integrationId,
      params.organizationId,
      params.clientId,
      params.webhookId,
      params.eventType,
      JSON.stringify(params.rawJson),
      params.bodyHash,
    ],
  );

  if (rows.length > 0) {
    return {
      businessEvent: mapBusinessEvent(rows[0] as unknown as Record<string, unknown>),
      isDuplicate: false,
      bodyMismatch: false,
    };
  }

  const existing = await sql`
    SELECT ${sql.unsafe(BE_SELECT)}
    FROM business_events
    WHERE "integrationId" = ${params.integrationId}
      AND "webhookId" = ${params.webhookId}
  `;

  const event = mapBusinessEvent(existing[0] as unknown as Record<string, unknown>);
  const match = event.bodyHash === params.bodyHash;

  return {
    businessEvent: event,
    isDuplicate: true,
    bodyMismatch: !match,
  };
}

export async function getBusinessEvent(
  sql: postgres.Sql,
  params: {
    integrationId: string;
    webhookId: string;
  },
): Promise<BusinessEventRow | null> {
  const rows = await sql`
    SELECT ${sql.unsafe(BE_SELECT)}
    FROM business_events
    WHERE "integrationId" = ${params.integrationId}
      AND "webhookId" = ${params.webhookId}
  `;
  if (rows.length === 0) return null;
  return mapBusinessEvent(rows[0] as unknown as Record<string, unknown>);
}

export async function markEventProjected(
  sql: postgres.Sql,
  eventId: string,
  integrationId: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT mark_business_event_result_safe(
      ${eventId}::uuid,
      ${integrationId}::uuid,
      'projected',
      NULL
    ) AS updated
  `;
  return (rows[0] as { updated: boolean }).updated;
}

export async function markEventUnhandled(
  sql: postgres.Sql,
  eventId: string,
  integrationId: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT mark_business_event_result_safe(
      ${eventId}::uuid,
      ${integrationId}::uuid,
      'unhandled',
      NULL
    ) AS updated
  `;
  return (rows[0] as { updated: boolean }).updated;
}

export async function markEventFailed(
  sql: postgres.Sql,
  eventId: string,
  integrationId: string,
  errorMessage?: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT mark_business_event_result_safe(
      ${eventId}::uuid,
      ${integrationId}::uuid,
      'failed',
      ${errorMessage ?? null}
    ) AS updated
  `;
  return (rows[0] as { updated: boolean }).updated;
}

export async function createOutboxMessage(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    integrationId: string;
    clientId: string;
    aggregateType: string;
    aggregateId: string;
    messageType: string;
    payload: Record<string, unknown>;
  },
): Promise<OutboxRow> {
  const rows = await sql.unsafe(
    `INSERT INTO outbox (
       "organizationId", "integrationId", "clientId",
       aggregate_type, aggregate_id, message_type, payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, (($7::jsonb #>> '{}')::jsonb))
     RETURNING id, "organizationId", "integrationId", "clientId",
               aggregate_type AS "aggregateType",
               aggregate_id AS "aggregateId",
               message_type AS "messageType",
               payload, status, "lockedAt", "lockedBy",
               attempt_count AS "attemptCount",
               max_attempts AS "maxAttempts",
               "nextAttemptAt",
               last_error AS "lastError",
               "deliveredAt", "createdAt"`,
    [
      params.organizationId,
      params.integrationId,
      params.clientId,
      params.aggregateType,
      params.aggregateId,
      params.messageType,
      JSON.stringify(params.payload),
    ],
  );
  return mapOutboxRow(rows[0] as unknown as Record<string, unknown>);
}

export async function markOutboxDelivered(
  sql: postgres.Sql,
  outboxId: string,
  workerId: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT mark_outbox_delivered_safe(${outboxId}::uuid, ${workerId}) AS updated
  `;
  return (rows[0] as { updated: boolean }).updated;
}

export async function markOutboxFailed(
  sql: postgres.Sql,
  outboxId: string,
  workerId: string,
  error: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT mark_outbox_failed_safe(${outboxId}::uuid, ${workerId}, ${error}) AS updated
  `;
  return (rows[0] as { updated: boolean }).updated;
}

export async function claimOutboxItems(
  sql: postgres.Sql,
  workerId: string,
  batchSize = 10,
): Promise<OutboxRow[]> {
  const rows = await sql`
    SELECT * FROM claim_outbox_items(${workerId}, ${batchSize})
  `;
  return ((rows as unknown) as Record<string, unknown>[]).map(mapOutboxRow);
}

export async function getFailedEvents(
  sql: postgres.Sql,
  organizationId: string,
): Promise<BusinessEventRow[]> {
  const rows = await sql`
    SELECT ${sql.unsafe(BE_SELECT)}
    FROM business_events
    WHERE "organizationId" = ${organizationId}
      AND status = 'failed'
    ORDER BY "receivedAt" DESC
  `;
  return ((rows as unknown) as Record<string, unknown>[]).map(mapBusinessEvent);
}

export async function getFailedEventsForTenant(
  pool: postgres.Sql,
  actor: Actor,
): Promise<BusinessEventRow[]> {
  return withTenantContext(pool, actor, async (tx) => {
    const rows = await tx`
      SELECT ${tx.unsafe(BE_SELECT)}
      FROM business_events
      WHERE "organizationId" = ${actor.organizationId}
        AND status = 'failed'
      ORDER BY "receivedAt" DESC
    `;
    return ((rows as unknown) as Record<string, unknown>[]).map(mapBusinessEvent);
  });
}
