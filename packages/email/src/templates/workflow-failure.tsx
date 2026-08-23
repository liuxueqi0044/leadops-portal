import { Html, Head, Body, Container, Section, Column, Row, Text, Link, Heading } from "@react-email/components";
import type React from "react";

export interface WorkflowFailureEmailProps {
  workflowName: string;
  runId: string;
  errorSummary: string;
  occurredAt: string;
  clientName: string;
  portalLink?: string | null;
}

export function WorkflowFailureEmail(props: WorkflowFailureEmailProps): React.ReactElement {
  return (
    <Html><Head /><Body style={{ fontFamily: "system-ui, sans-serif", backgroundColor: "#f9fafb", padding: "20px 0" }}>
      <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "20px", backgroundColor: "#fff", borderRadius: "8px" }}>
        <Section style={{ borderLeft: "4px solid #dc2626", padding: "16px 20px", backgroundColor: "#fef2f2", marginBottom: "20px" }}>
          <Heading as="h2" style={{ color: "#dc2626", margin: "0" }}>Workflow Failure</Heading>
        </Section>
        <Section style={{ margin: "16px 0" }}>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "35%" }}>Workflow</Column><Column>{props.workflowName}</Column></Row>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "35%" }}>Run ID</Column><Column>{props.runId}</Column></Row>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "35%" }}>Client</Column><Column>{props.clientName}</Column></Row>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "35%" }}>Occurred at</Column><Column>{props.occurredAt}</Column></Row>
          <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "35%" }}>Error</Column><Column>{props.errorSummary}</Column></Row>
        </Section>
        {props.portalLink ? <Link href={props.portalLink} style={{ color: "#0f3460" }}>View details in portal</Link> : null}
        <Text style={{ marginTop: "24px", fontSize: "0.875em", color: "#666" }}>This is an automated message from LeadOps Portal.</Text>
      </Container>
    </Body></Html>
  );
}

export function buildWorkflowFailureSubject(workflowName: string): string {
  return "[Action Required] Workflow Failed: " + workflowName;
}

export function buildWorkflowFailureText(props: WorkflowFailureEmailProps): string {
  const lines: string[] = [];
  lines.push("Workflow Failure Alert"); lines.push("=".repeat(22)); lines.push("");
  lines.push("Workflow: " + props.workflowName);
  lines.push("Run ID: " + props.runId);
  lines.push("Client: " + props.clientName);
  lines.push("Occurred at: " + props.occurredAt);
  lines.push("Error: " + props.errorSummary);
  lines.push("");
  if (props.portalLink) { lines.push("View details: " + props.portalLink); lines.push(""); }
  lines.push("This is an automated message from LeadOps Portal.");
  return lines.join("\n");
}
