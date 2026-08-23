import { render } from "@react-email/render";
import type React from "react";

export { createFakeEmailProvider, isSendResultRetryable } from "./provider.js";
export type { EmailProvider, EmailSendRequest, EmailSendResult } from "./provider.js";

export {
  createResendEmailProvider,
  type ResendEmailProviderOptions,
} from "./resend-provider.js";

export {
  ApprovalRequestEmail,
  buildApprovalRequestSubject,
  buildApprovalRequestText,
} from "./templates/approval-request.js";
export type { ApprovalRequestEmailProps } from "./templates/approval-request.js";

export {
  ApprovalResultEmail,
  buildApprovalResultSubject,
  buildApprovalResultText,
} from "./templates/approval-result.js";
export type { ApprovalResultEmailProps } from "./templates/approval-result.js";

export {
  WorkflowFailureEmail,
  buildWorkflowFailureSubject,
  buildWorkflowFailureText,
} from "./templates/workflow-failure.js";
export type { WorkflowFailureEmailProps } from "./templates/workflow-failure.js";

export {
  WeeklyReportEmail,
  buildWeeklyReportSubject,
  buildWeeklyReportText,
} from "./templates/weekly-report.js";
export type { WeeklyReportEmailProps } from "./templates/weekly-report.js";

export async function renderReactEmail(component: React.ReactElement): Promise<string> {
  return render(component, { plainText: false });
}

export async function renderReactEmailText(component: React.ReactElement): Promise<string> {
  return render(component, { plainText: true });
}
