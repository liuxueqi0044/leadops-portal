import { NextRequest } from "next/server";
import type postgres from "postgres";
import {
  getDefaultDatabase,
  getIntegrationForVerification,
  receiveBusinessEvent,
  createOutboxMessage,
  markEventUnhandled,
  withIntegrationContext,
} from "@leadops/db";
import {
  verifyWebhookSignature,
  computeBodyHash,
  parseEnvelope,
  parseEvent,
  EVENT_TYPES,
} from "@leadops/events";
import { createLogger, recordWebhookSignatureFailure } from "@leadops/observability";

const MAX_BODY_SIZE = 1024 * 1024;
const logger = createLogger({ service: "web-events" });

function castTx(tx: unknown): postgres.Sql {
  return tx as postgres.Sql;
}

async function readRawBody(request: Request): Promise<Buffer | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength)) {
    if (Number(declaredLength) > MAX_BODY_SIZE) return null;
  }

  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_SIZE) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const msgId = request.headers.get("webhook-id");
    const msgTimestamp = request.headers.get("webhook-timestamp");
    const msgSignature = request.headers.get("webhook-signature");
    const integrationId = request.headers.get("x-leadops-integration-id");

    if (!msgId || !msgTimestamp || !msgSignature) {
      recordWebhookSignatureFailure();
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Missing required webhook headers" } },
        { status: 401 },
      );
    }

    if (!integrationId) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Missing x-leadops-integration-id header" } },
        { status: 401 },
      );
    }

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(integrationId)) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid integration identifier" } },
        { status: 401 },
      );
    }

    if (!/^[a-zA-Z0-9\-_]{1,200}$/.test(msgId)) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid webhook-id" } },
        { status: 401 },
      );
    }

    const rawBody = await readRawBody(request);
    if (!rawBody) {
      return Response.json(
        { error: { code: "INVALID", message: "Body too large" } },
        { status: 400 },
      );
    }

    const bodyHash = computeBodyHash(rawBody);

    const handle = getDefaultDatabase();
    const integrationResult = await getIntegrationForVerification(handle.sql, integrationId);

    if (!integrationResult) {
      recordWebhookSignatureFailure();
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Unknown or revoked integration" } },
        { status: 401 },
      );
    }

    const verifyResult = verifyWebhookSignature(
      rawBody,
      {
        "webhook-id": msgId,
        "webhook-timestamp": msgTimestamp,
        "webhook-signature": msgSignature,
      },
      integrationResult.secrets,
    );

    if (!verifyResult.valid) {
      recordWebhookSignatureFailure();
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: verifyResult.error ?? "Invalid signature" } },
        { status: 401 },
      );
    }

    // ---- Signature verified. Now JSON parse (decoupled from signature check) ----
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      return Response.json(
        { error: { code: "INVALID", message: "Invalid JSON body" } },
        { status: 422 },
      );
    }

    // ---- Layer 1: base envelope + schemaVersion ----
    let envelope;
    try {
      envelope = parseEnvelope(payload);
    } catch {
      return Response.json(
        { error: { code: "INVALID", message: "Invalid event envelope" } },
        { status: 422 },
      );
    }

    if (envelope.metadata.schemaVersion !== "1.0") {
      return Response.json(
        { error: { code: "INVALID", message: `Unsupported schemaVersion: ${envelope.metadata.schemaVersion}` } },
        { status: 422 },
      );
    }

    // ---- Tenant validation ----
    const { integration } = integrationResult;
    if (envelope.organizationId !== integration.organizationId) {
      return Response.json(
        { error: { code: "INVALID", message: "Organization mismatch with integration" } },
        { status: 400 },
      );
    }
    if (envelope.clientId !== integration.clientId) {
      return Response.json(
        { error: { code: "INVALID", message: "Client mismatch with integration" } },
        { status: 400 },
      );
    }

    // ---- Layer 2: known eventType -> full validation; unknown -> save unhandled ----
    const isKnownType = (EVENT_TYPES as readonly string[]).includes(envelope.eventType);

    if (isKnownType) {
      try {
        // Full discriminated union validation for known types
        parseEvent(payload);
      } catch {
        return Response.json(
          { error: { code: "INVALID", message: "Event payload does not match expected schema for type" } },
          { status: 422 },
        );
      }
    }

    // ---- Process in transaction with integration context ----
    const result = await withIntegrationContext(
      handle.sql,
      {
        integrationId: integration.id,
        organizationId: integration.organizationId,
        clientId: integration.clientId,
      },
      async (tx) => {
        const sql = castTx(tx);
        const receiveResult = await receiveBusinessEvent(sql, {
          integrationId: integration.id,
          organizationId: integration.organizationId,
          clientId: integration.clientId,
          webhookId: msgId,
          eventType: envelope.eventType,
          rawJson: payload as Record<string, unknown>,
          bodyHash,
        });

        if (receiveResult.isDuplicate) {
          if (receiveResult.bodyMismatch) {
            return { status: 409 as const, event: receiveResult.businessEvent };
          }
          return { status: 200 as const, event: receiveResult.businessEvent };
        }

        if (isKnownType) {
          await createOutboxMessage(sql, {
            organizationId: integration.organizationId,
            integrationId: integration.id,
            clientId: integration.clientId,
            aggregateType: "business_event",
            aggregateId: receiveResult.businessEvent.id,
            messageType: "events.project",
            payload: {
              schemaVersion: 1,
              eventId: receiveResult.businessEvent.id,
              eventType: envelope.eventType,
              organizationId: integration.organizationId,
              clientId: integration.clientId,
              integrationId: integration.id,
            },
          });
        } else {
          await markEventUnhandled(sql, receiveResult.businessEvent.id, integration.id);
        }

        return { status: 202 as const, event: receiveResult.businessEvent };
      },
    );

    if (result.status === 409) {
      return Response.json(
        { error: { code: "CONFLICT", message: "Duplicate webhook-id with different payload" } },
        { status: 409 },
      );
    }

    if (result.status === 200) {
      return Response.json(
        { duplicate: true, eventId: result.event.id },
        { status: 200 },
      );
    }

    return Response.json(
      { accepted: true, eventId: result.event.id },
      { status: 202 },
    );
  } catch (err: unknown) {
    if (err instanceof Error) {
      logger.error(
        { event: "event.ingest_error", error: err.message },
        "Event ingestion failed",
      );
      return Response.json(
        { error: { code: "INTERNAL", message: "Internal server error" } },
        { status: 500 },
      );
    }
    throw err;
  }
}
