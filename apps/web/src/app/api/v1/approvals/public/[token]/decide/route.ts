import { NextResponse } from "next/server";
import { createLogger } from "@leadops/observability";
import {
  getDefaultDatabase,
  consumeTokenAndDecide,
} from "@leadops/db";
import {
  publicDecideRequestSchema,
} from "@leadops/core";

const log = createLogger({ service: "api:approvals-public-decide" });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    if (!token || token.length < 8) {
      log.warn("public approval decide with short token");
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Approval not found" },
        { status: 404 },
      );
    }

    const body: unknown = await request.json();
    const parsed = publicDecideRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "INVALID_INPUT", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const db = getDefaultDatabase();

    // Use SECURITY DEFINER function for public token consumption
    const result = await consumeTokenAndDecide(
      db.sql,
      token,
      parsed.data.decision,
      "public_token",
      parsed.data.reason,
    );

    if (!result.decided) {
      // Map token/approval status to appropriate error
      if (result.tokenStatus === "already_used") {
        return NextResponse.json(
          { error: "TOKEN_ALREADY_USED", message: "This approval link has already been used" },
          { status: 409 },
        );
      }
      if (result.tokenStatus === "expired") {
        return NextResponse.json(
          { error: "TOKEN_EXPIRED", message: "This approval link has expired" },
          { status: 410 },
        );
      }
      if (result.tokenStatus === "revoked") {
        return NextResponse.json(
          { error: "TOKEN_REVOKED", message: "This approval link has been revoked" },
          { status: 410 },
        );
      }
      if (result.status !== "pending") {
        return NextResponse.json(
          {
            error: "APPROVAL_ALREADY_DECIDED",
            message: `Approval is already in status '${result.status}'`,
            approval: { status: result.status, version: result.version },
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Approval not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      status: result.status,
      version: result.version,
      decidedAt: new Date().toISOString(),
    });
  } catch (error) {
    log.error({ err: error }, "public approval decide failed");
    return NextResponse.json(
      { error: "INTERNAL", message: "Internal server error" },
      { status: 500 },
    );
  }
}
