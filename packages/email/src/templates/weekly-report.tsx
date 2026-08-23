import { Html, Head, Body, Container, Section, Column, Row, Text, Link, Heading } from "@react-email/components";
import type React from "react";

export interface WeeklyReportEmailProps {
  clientName: string;
  periodStart: string;
  periodEnd: string;
  leadsReceived: number;
  qualificationRate: string;
  approvalConversion: string;
  appointments: number;
  workflowSuccessCount: number;
  workflowFailureCount: number;
  openIncidents: number;
  portalLink?: string | null;
}

export function WeeklyReportEmail(props: WeeklyReportEmailProps): React.ReactElement {
  return (
    <Html><Head /><Body style={{ fontFamily: "system-ui, sans-serif", backgroundColor: "#f9fafb", padding: "20px 0" }}>
      <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "20px", backgroundColor: "#fff", borderRadius: "8px" }}>
        <Heading as="h2" style={{ color: "#16213e", marginBottom: "4px" }}>Weekly Report: {props.clientName}</Heading>
        <Text style={{ color: "#666", marginTop: "0", fontSize: "0.875em" }}>{props.periodStart} - {props.periodEnd}</Text>
        <Section style={{ margin: "16px 0" }}>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "60%" }}>Leads Received</Column><Column>{String(props.leadsReceived)}</Column></Row>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "60%" }}>Qualification Rate</Column><Column>{props.qualificationRate}</Column></Row>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "60%" }}>Approval Conversion</Column><Column>{props.approvalConversion}</Column></Row>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "60%" }}>Appointments</Column><Column>{String(props.appointments)}</Column></Row>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "60%" }}>Workflow Success</Column><Column>{String(props.workflowSuccessCount)}</Column></Row>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "60%" }}>Workflow Failures</Column><Column>{String(props.workflowFailureCount)}</Column></Row>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "60%" }}>Open Incidents</Column><Column>{String(props.openIncidents)}</Column></Row>
        </Section>
        {props.portalLink ? <Link href={props.portalLink} style={{ color: "#0f3460" }}>View full report in portal</Link> : null}
        <Text style={{ marginTop: "24px", fontSize: "0.875em", color: "#666" }}>This is an automated weekly report from LeadOps Portal.</Text>
      </Container>
    </Body></Html>
  );
}

export function buildWeeklyReportSubject(clientName: string, periodStart: string, periodEnd: string): string {
  return "Weekly Report: " + clientName + " (" + periodStart + " - " + periodEnd + ")";
}

export function buildWeeklyReportText(props: WeeklyReportEmailProps): string {
  const lines: string[] = [];
  lines.push("Weekly Report: " + props.clientName);
  lines.push("Period: " + props.periodStart + " - " + props.periodEnd);
  lines.push("=".repeat(50)); lines.push("");
  lines.push("Leads Received: " + String(props.leadsReceived));
  lines.push("Qualification Rate: " + props.qualificationRate);
  lines.push("Approval Conversion: " + props.approvalConversion);
  lines.push("Appointments: " + String(props.appointments));
  lines.push("Workflow Success: " + String(props.workflowSuccessCount));
  lines.push("Workflow Failures: " + String(props.workflowFailureCount));
  lines.push("Open Incidents: " + String(props.openIncidents));
  lines.push("");
  if (props.portalLink) { lines.push("View full report: " + props.portalLink); lines.push(""); }
  lines.push("This is an automated weekly report from LeadOps Portal.");
  return lines.join("\n");
}
