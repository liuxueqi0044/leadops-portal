import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Column,
  Row,
  Text,
  Link,
  Heading,
} from "@react-email/components";
import type React from "react";

export interface ApprovalRequestEmailProps {
  contactName?: string | null;
  company?: string | null;
  leadMessage?: string | null;
  qualificationSummary?: string | null;
  score?: number | null;
  approvalLink: string;
  expiresAt: string;
}

export function ApprovalRequestEmail({
  contactName,
  company,
  leadMessage,
  qualificationSummary,
  score,
  approvalLink,
  expiresAt,
}: ApprovalRequestEmailProps): React.ReactElement {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: "system-ui, sans-serif", backgroundColor: "#f9fafb", padding: "20px 0" }}>
        <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "20px", backgroundColor: "#fff", borderRadius: "8px" }}>
          <Heading as="h2" style={{ color: "#16213e", margin: "0 0 16px 0" }}>
            Action Required: Review This Lead
          </Heading>
          <Section style={{ margin: "16px 0" }}>
            {contactName ? (
              <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}>
                <Column style={{ fontWeight: 600, width: "35%" }}>Contact</Column>
                <Column>{contactName}</Column>
              </Row>
            ) : null}
            {company ? (
              <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}>
                <Column style={{ fontWeight: 600, width: "35%" }}>Company</Column>
                <Column>{company}</Column>
              </Row>
            ) : null}
            {leadMessage ? (
              <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}>
                <Column style={{ fontWeight: 600, width: "35%" }}>Message</Column>
                <Column>{leadMessage}</Column>
              </Row>
            ) : null}
            {score != null ? (
              <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}>
                <Column style={{ fontWeight: 600, width: "35%" }}>Lead Score</Column>
                <Column>{String(score)}/100</Column>
              </Row>
            ) : null}
            {qualificationSummary ? (
              <Row style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}>
                <Column style={{ fontWeight: 600, width: "35%" }}>AI Assessment</Column>
                <Column>{qualificationSummary}</Column>
              </Row>
            ) : null}
          </Section>
          <Text style={{ margin: "16px 0" }}>
            To review and approve or reject this lead, please click the button below:
          </Text>
          <Link
            href={approvalLink}
            style={{
              display: "inline-block",
              backgroundColor: "#0f3460",
              color: "#fff",
              padding: "12px 24px",
              textDecoration: "none",
              borderRadius: "6px",
              fontWeight: 600,
            }}
          >
            Review Lead
          </Link>
          <Text style={{ marginTop: "24px", fontSize: "0.875em", color: "#666" }}>
            This link expires at: {expiresAt}
          </Text>
          <Text style={{ marginTop: "24px", fontSize: "0.875em", color: "#666" }}>
            This is an automated message from LeadOps Portal.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export function buildApprovalRequestSubject(): string {
  return "Action Required: Review This Lead";
}

export function buildApprovalRequestText(props: ApprovalRequestEmailProps): string {
  const lines: string[] = [];
  lines.push("Action Required: Review This Lead");
  lines.push("====================================");
  lines.push("");
  if (props.contactName) lines.push("Contact: " + props.contactName);
  if (props.company) lines.push("Company: " + props.company);
  if (props.leadMessage) lines.push("Message: " + props.leadMessage);
  if (props.score != null) lines.push("Lead Score: " + String(props.score) + "/100");
  if (props.qualificationSummary) lines.push("AI Assessment: " + props.qualificationSummary);
  lines.push("");
  lines.push("To review and approve or reject this lead, visit:");
  lines.push(props.approvalLink);
  lines.push("");
  lines.push("This link expires at: " + props.expiresAt);
  lines.push("");
  lines.push("This is an automated message from LeadOps Portal.");
  return lines.join("\n");
}
