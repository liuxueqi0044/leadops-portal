import { Html, Head, Body, Container, Section, Column, Row, Text, Link, Heading } from "@react-email/components";
import type React from "react";

export interface ApprovalResultEmailProps {
  decision: "approved" | "rejected" | "expired";
  contactName?: string | null;
  company?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  decisionReason?: string | null;
  portalLink?: string | null;
}

export function ApprovalResultEmail(props: ApprovalResultEmailProps): React.ReactElement {
  const label = props.decision === "approved" ? "Approved" : props.decision === "rejected" ? "Rejected" : "Expired";
  const color = props.decision === "approved" ? "#16a34a" : props.decision === "rejected" ? "#dc2626" : "#9ca3af";
  return (
    <Html><Head /><Body style={{ fontFamily: "system-ui, sans-serif", backgroundColor: "#f9fafb", padding: "20px 0" }}>
      <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "20px", backgroundColor: "#fff", borderRadius: "8px" }}>
        <Section style={{ borderLeft: "4px solid " + color, padding: "16px 20px", backgroundColor: "#f9fafb", marginBottom: "20px" }}>
          <Heading as="h2" style={{ color, margin: "0" }}>Lead {label}</Heading>
        </Section>
        <Section style={{ margin: "16px 0" }}>
          {props.contactName ? <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "35%" }}>Contact</Column><Column>{props.contactName}</Column></Row> : null}
          {props.company ? <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "35%" }}>Company</Column><Column>{props.company}</Column></Row> : null}
          {props.decidedBy ? <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "35%" }}>Decided by</Column><Column>{props.decidedBy}</Column></Row> : null}
          {props.decidedAt ? <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "35%" }}>Decided at</Column><Column>{props.decidedAt}</Column></Row> : null}
          {props.decisionReason ? <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}><Column style={{ fontWeight: 600, width: "35%" }}>Reason</Column><Column>{props.decisionReason}</Column></Row> : null}
        </Section>
        {props.portalLink ? <Link href={props.portalLink} style={{ color: "#0f3460" }}>View in portal</Link> : null}
        <Text style={{ marginTop: "24px", fontSize: "0.875em", color: "#666" }}>This is an automated message from LeadOps Portal.</Text>
      </Container>
    </Body></Html>
  );
}

export function buildApprovalResultSubject(decision: string): string {
  const map: Record<string, string> = { approved: "Lead Approved", rejected: "Lead Rejected", expired: "Approval Expired" };
  return map[decision] ?? "Approval Update";
}

export function buildApprovalResultText(props: ApprovalResultEmailProps): string {
  const lines: string[] = [];
  lines.push("Lead " + (props.decision === "approved" ? "Approved" : props.decision === "rejected" ? "Rejected" : "Approval Expired"));
  lines.push("=".repeat(40)); lines.push("");
  if (props.contactName) lines.push("Contact: " + props.contactName);
  if (props.company) lines.push("Company: " + props.company);
  if (props.decidedBy) lines.push("Decided by: " + props.decidedBy);
  if (props.decidedAt) lines.push("Decided at: " + props.decidedAt);
  if (props.decisionReason) lines.push("Reason: " + props.decisionReason);
  lines.push("");
  if (props.portalLink) { lines.push("View in portal: " + props.portalLink); lines.push(""); }
  lines.push("This is an automated message from LeadOps Portal.");
  return lines.join("\n");
}
