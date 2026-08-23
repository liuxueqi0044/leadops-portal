import { NextResponse } from "next/server";
import { createLogger } from "@leadops/observability";
import {
  getDefaultDatabase,
  lookupApprovalByToken,
} from "@leadops/db";

const log = createLogger({ service: "api:approvals-public" });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    if (!token || token.length < 8) {
      log.warn("public approval lookup with short token");
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Approval not found" },
        { status: 404 },
      );
    }

    const db = getDefaultDatabase();

    // Look up via SECURITY DEFINER function (no tenant context needed)
    const lookup = await lookupApprovalByToken(db.sql, token);

    if (lookup.tokenStatus === "not_found" || !lookup.approvalId) {
      log.warn({ tokenStatus: lookup.tokenStatus }, "public approval not found");
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Approval not found" },
        { status: 404 },
      );
    }

    // Build public-safe DTO: only decision-relevant data, no internal IDs
    const publicDto: Record<string, unknown> = {
      tokenStatus: lookup.tokenStatus,
      status: lookup.status ?? "unknown",
      snapshot: lookup.snapshot ?? {},
      expiresAt: lookup.expiresAt,
    };

    // Don't expose internal organizationId, clientId, lead data, AI prompts, etc.
    // The snapshot already contains only approved display fields.

    return NextResponse.json(publicDto);
  } catch (error) {
    log.error({ err: error }, "public approval lookup failed");
    return NextResponse.json(
      { error: "INTERNAL", message: "Internal server error" },
      { status: 500 },
    );
  }
}
