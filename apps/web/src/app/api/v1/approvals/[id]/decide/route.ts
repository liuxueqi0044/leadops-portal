import { NextResponse } from "next/server";
import { createLogger } from "@leadops/observability";
import {
  getDefaultDatabase,
  decideApprovalForTenant,
  getApprovalForTenant,
} from "@leadops/db";
import {
  decideApprovalRequestSchema,
  assertCan,
} from "@leadops/core";
import { getActorFromRequest } from "@/lib/server/actor";
import { handleServiceError } from "@/lib/server/errors";

const log = createLogger({ service: "api:approvals-decide" });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await getActorFromRequest(request);
    if (!actor) {
      return NextResponse.json(
        { error: "UNAUTHENTICATED", message: "Authentication required" },
        { status: 401 },
      );
    }

    const { id: approvalId } = await params;
    const body: unknown = await request.json();
    const parsed = decideApprovalRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "INVALID_INPUT", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const db = getDefaultDatabase();
    const approval = await getApprovalForTenant(db.sql, actor, approvalId);
    if (!approval) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Approval not found" },
        { status: 404 },
      );
    }

    assertCan(actor, "approval:decide", {
      organizationId: actor.organizationId,
      clientId: approval.clientId,
    });

    const result = await decideApprovalForTenant(db.sql, actor, {
      approvalId,
      clientId: approval.clientId,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
      expectedVersion: parsed.data.expectedVersion,
    });

    if (!result.decided) {
      return NextResponse.json(
        {
          error: "APPROVAL_ALREADY_DECIDED",
          message: `Approval is already in status '${result.status}'`,
          approval: {
            id: result.id,
            status: result.status,
            version: result.version,
          },
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      id: result.id,
      status: result.status,
      version: result.version,
      decidedAt: new Date().toISOString(),
    });
  } catch (error) {
    log.error({ err: error }, "approval decide failed");
    return handleServiceError(error);
  }
}
