import { describe, expect, it } from "vitest";
import { renderReactEmail, ApprovalRequestEmail, buildApprovalRequestSubject, buildApprovalRequestText } from "./index.js";

describe("Approval Request Email (React)", () => {
  const props = {
    contactName: "A & B <script>",
    company: "Example Co",
    leadMessage: "Please review",
    qualificationSummary: "High intent",
    score: 91,
    approvalLink: "https://portal.example.com/approval/public/safe_public_token",
    expiresAt: "2026-08-10T00:00:00.000Z",
  };

  it("renders approval link without exposing internal identifiers", async () => {
    const html = await renderReactEmail(ApprovalRequestEmail(props));
    expect(html).toContain("approval/public/safe_public_token");
  });

  it("escapes HTML in contact name", async () => {
    const html = await renderReactEmail(ApprovalRequestEmail(props));
    expect(html).toContain("A &amp; B &lt;script&gt;");
    expect(html).not.toContain("A & B <script>");
  });

  it("renders plain text via builder", () => {
    const text = buildApprovalRequestText(props);
    expect(text).toContain(props.approvalLink);
    expect(text).toContain("Lead Score: 91/100");
  });

  it("builds correct subject", () => {
    expect(buildApprovalRequestSubject()).toBe("Action Required: Review This Lead");
  });
});
