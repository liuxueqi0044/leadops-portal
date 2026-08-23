import { describe, expect, it } from "vitest";
import { renderReactEmail } from "../index.js";
import {
  WeeklyReportEmail,
  buildWeeklyReportSubject,
  buildWeeklyReportText,
} from "../templates/weekly-report.js";

describe("Weekly Report Email (React)", () => {
  const props = {
    clientName: "Client <u>A</u>",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-07",
    leadsReceived: 150,
    qualificationRate: "73.3%",
    approvalConversion: "62.5%",
    appointments: 12,
    workflowSuccessCount: 45,
    workflowFailureCount: 3,
    openIncidents: 2,
    portalLink: "https://portal.example.com/reports/weekly",
  };

  it("builds correct subject", () => {
    expect(buildWeeklyReportSubject("Client A", "2026-01-01", "2026-01-07"))
      .toBe("Weekly Report: Client A (2026-01-01 - 2026-01-07)");
  });

  it("renders HTML via @react-email/render", async () => {
    const html = await renderReactEmail(WeeklyReportEmail(props));
    expect(html).toContain("Client &lt;u&gt;A&lt;/u&gt;");
    expect(html).toContain("150");
    expect(html).toContain("73.3%");
  });

  it("includes all metrics in HTML", async () => {
    const html = await renderReactEmail(WeeklyReportEmail(props));
    expect(html).toContain("150");
    expect(html).toContain("62.5%");
    expect(html).toContain("12");
    expect(html).toContain("45");
    expect(html).toContain("3");
    expect(html).toContain("2");
  });

  it("renders plain text", () => {
    const text = buildWeeklyReportText(props);
    expect(text).toContain("Leads Received: 150");
    expect(text).toContain("Workflow Failures: 3");
  });

  it("handles all-zero data", async () => {
    const html = await renderReactEmail(WeeklyReportEmail({
      clientName: "Empty", periodStart: "2026-01-01", periodEnd: "2026-01-07",
      leadsReceived: 0, qualificationRate: "0%", approvalConversion: "0%",
      appointments: 0, workflowSuccessCount: 0, workflowFailureCount: 0, openIncidents: 0,
    }));
    expect(html).toContain("Leads Received");
  });
});
