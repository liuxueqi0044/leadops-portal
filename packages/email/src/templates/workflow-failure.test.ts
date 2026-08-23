import { describe, expect, it } from "vitest";
import { renderReactEmail } from "../index.js";
import {
  WorkflowFailureEmail,
  buildWorkflowFailureSubject,
  buildWorkflowFailureText,
} from "../templates/workflow-failure.js";

describe("Workflow Failure Email (React)", () => {
  const props = {
    workflowName: "Lead Import <script>",
    runId: "run-123",
    errorSummary: "Connection <b>refused</b>",
    occurredAt: "2026-01-15T10:00:00.000Z",
    clientName: "Client A",
    portalLink: "https://portal.example.com/runs/123",
  };

  it("builds correct subject", () => {
    expect(buildWorkflowFailureSubject("Lead Import <script>"))
      .toBe("[Action Required] Workflow Failed: Lead Import <script>");
  });

  it("renders HTML via @react-email/render", async () => {
    const html = await renderReactEmail(WorkflowFailureEmail(props));
    expect(html).toContain("Workflow Failure");
    expect(html).toContain("Lead Import &lt;script&gt;");
  });

  it("escapes HTML in error summary", async () => {
    const html = await renderReactEmail(WorkflowFailureEmail(props));
    expect(html).toContain("Connection &lt;b&gt;refused&lt;/b&gt;");
  });

  it("renders plain text", () => {
    const text = buildWorkflowFailureText(props);
    expect(text).toContain("Workflow Failure Alert");
    expect(text).toContain("run-123");
  });

  it("handles null portal link", async () => {
    const html = await renderReactEmail(WorkflowFailureEmail({
      workflowName: "Test", runId: "r1", errorSummary: "err",
      occurredAt: "2026-01-01T00:00:00.000Z", clientName: "C",
      portalLink: null,
    }));
    expect(html).not.toContain("View details");
  });
});
