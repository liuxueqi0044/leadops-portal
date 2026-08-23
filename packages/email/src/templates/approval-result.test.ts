import { describe, expect, it } from "vitest";
import { renderReactEmail, renderReactEmailText } from "../index.js";
import {
  ApprovalResultEmail,
  buildApprovalResultSubject,
  buildApprovalResultText,
} from "../templates/approval-result.js";

describe("Approval Result Email (React)", () => {
  const props = {
    decision: "approved" as const,
    contactName: "John <script>alert(1)</script>",
    company: "Acme Corp",
    decidedBy: "Admin",
    decidedAt: "2026-01-15T10:00:00.000Z",
    decisionReason: "Good lead",
    portalLink: "https://portal.example.com/approval/1",
  };

  it("builds correct subject for approved", () => {
    expect(buildApprovalResultSubject("approved")).toBe("Lead Approved");
  });

  it("builds correct subject for rejected", () => {
    expect(buildApprovalResultSubject("rejected")).toBe("Lead Rejected");
  });

  it("builds correct subject for expired", () => {
    expect(buildApprovalResultSubject("expired")).toBe("Approval Expired");
  });

  it("renders HTML via @react-email/render", async () => {
    const html = await renderReactEmail(ApprovalResultEmail(props));
    expect(html).toContain("Acme Corp");
  });

  it("escapes HTML in contact name in React output", async () => {
    const html = await renderReactEmail(ApprovalResultEmail(props));
    expect(html).toContain("John &lt;script&gt;");
    expect(html).not.toContain("John <script>alert");
  });

  it("renders plain text via builder", () => {
    const text = buildApprovalResultText(props);
    expect(text).toContain("Lead Approved");
    expect(text).toContain("John <script>alert(1)</script>");
    expect(text).toContain("Acme Corp");
  });

  it("renders plain text via @react-email/render", async () => {
    const text = await renderReactEmailText(ApprovalResultEmail(props));
    expect(text).toContain("LEAD APPROVED");
  });

  it("handles null portal link", async () => {
    const html = await renderReactEmail(ApprovalResultEmail({ decision: "rejected" }));
    expect(html).not.toContain("View in portal");
  });
});
