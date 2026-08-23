import { NextResponse } from 'next/server';

import {
  createApprovalForIntegration,
  createApprovalForTenant,
  getDefaultDatabase,
  getIntegrationForVerification,
  listApprovalsForTenant,
  withTenantContext,
} from '@leadops/db';
import {
  approvalsListQuerySchema,
  approvalsListResponseSchema,
  assertCan,
  createApprovalRequestSchema,
} from '@leadops/core';
import { verifyWebhookSignature } from '@leadops/events';
import { createLogger } from '@leadops/observability';

import { getActorFromRequest } from '@/lib/server/actor';
import { handleServiceError } from '@/lib/server/errors';
import type postgres from 'postgres';

const log = createLogger({ service: 'api:approvals' });
const MAX_BODY_BYTES = 256 * 1024;

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await getActorFromRequest(request);
    if (!actor) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } },
        { status: 401 },
      );
    }

    const url = new URL(request.url);
    const parsed = approvalsListQuerySchema.safeParse({
      clientId: url.searchParams.get('clientId') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'INVALID_INPUT', message: 'Invalid approval query' } },
        { status: 400 },
      );
    }

    assertCan(actor, 'approval:read', {
      organizationId: actor.organizationId,
      clientId: parsed.data.clientId,
    });

    const db = getDefaultDatabase();
    const result = await withTenantContext(
      db.sql,
      { ...actor, clientId: parsed.data.clientId },
      async (tx) =>
        listApprovalsForTenant(tx as unknown as postgres.Sql, {
          organizationId: actor.organizationId,
          clientId: parsed.data.clientId,
          status: parsed.data.status,
          cursor: parsed.data.cursor,
          limit: parsed.data.limit ?? 50,
        }),
    );

    return NextResponse.json(
      approvalsListResponseSchema.parse({
        items: result.items.map((item) => ({
          id: item.id,
          clientId: item.clientId,
          leadId: item.leadId,
          status: item.status,
          version: item.version,
          expiresAt: item.expiresAt,
          snapshot: item.snapshot,
          requestedBy: item.requestedBy,
          decidedBy: item.decidedBy,
          decidedAt: item.decidedAt,
          decisionReason: item.decisionReason,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
        nextCursor: result.nextCursor,
      }),
    );
  } catch (error) {
    return handleServiceError(error);
  }
}

async function readRawBody(request: Request): Promise<Buffer | null> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_BODY_BYTES)
    return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

function approvalResponse(result: Awaited<ReturnType<typeof createApprovalForTenant>>): Response {
  const body: Record<string, unknown> = {
    id: result.id,
    status: result.status,
    version: result.version,
    expiresAt: result.expiresAt,
    snapshot: result.snapshot,
    createdAt: result.createdAt,
  };
  if (result.token) {
    body.token = result.token;
    body.tokenExpiresAt = result.tokenExpiresAt;
  }
  return NextResponse.json(body, { status: result.isNew ? 201 : 200 });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = await readRawBody(request);
    if (!rawBody) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'Body too large' },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'Invalid JSON body' },
        { status: 400 },
      );
    }
    const parsed = createApprovalRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const db = getDefaultDatabase();
    const actor = await getActorFromRequest(request);
    if (actor) {
      assertCan(actor, 'approval:create', {
        organizationId: actor.organizationId,
        clientId: parsed.data.clientId,
      });
      const result = await createApprovalForTenant(db.sql, actor, parsed.data.integrationId, {
        clientId: parsed.data.clientId,
        leadId: parsed.data.leadId,
        correlationId: parsed.data.correlationId,
        requestVersion: parsed.data.requestVersion,
        snapshot: parsed.data.snapshot,
        expiresInSeconds: parsed.data.expiresInSeconds,
        generateToken: parsed.data.generateToken,
      });
      return approvalResponse(result);
    }

    const integrationId = request.headers.get('x-leadops-integration-id');
    const webhookId = request.headers.get('webhook-id');
    const timestamp = request.headers.get('webhook-timestamp');
    const signature = request.headers.get('webhook-signature');
    if (
      !integrationId ||
      !webhookId ||
      !timestamp ||
      !signature ||
      !/^[a-zA-Z0-9_-]{1,200}$/u.test(webhookId)
    ) {
      return NextResponse.json(
        { error: 'UNAUTHENTICATED', message: 'Authentication required' },
        { status: 401 },
      );
    }

    const verified = await getIntegrationForVerification(db.sql, integrationId);
    if (
      !verified ||
      !verifyWebhookSignature(
        rawBody,
        {
          'webhook-id': webhookId,
          'webhook-timestamp': timestamp,
          'webhook-signature': signature,
        },
        verified.secrets,
      ).valid
    ) {
      return NextResponse.json(
        { error: 'UNAUTHENTICATED', message: 'Invalid integration signature' },
        { status: 401 },
      );
    }
    if (
      parsed.data.integrationId !== verified.integration.id ||
      parsed.data.clientId !== verified.integration.clientId
    ) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'Integration tenant binding mismatch' },
        { status: 400 },
      );
    }

    const result = await createApprovalForIntegration(
      db.sql,
      {
        integrationId: verified.integration.id,
        organizationId: verified.integration.organizationId,
        clientId: verified.integration.clientId,
      },
      {
        leadId: parsed.data.leadId,
        correlationId: parsed.data.correlationId,
        requestVersion: parsed.data.requestVersion,
        snapshot: parsed.data.snapshot,
        expiresInSeconds: parsed.data.expiresInSeconds,
        generateToken: parsed.data.generateToken,
      },
    );
    return approvalResponse(result);
  } catch (error) {
    log.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'approval create failed',
    );
    return handleServiceError(error);
  }
}
