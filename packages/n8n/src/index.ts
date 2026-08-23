// @leadops/n8n — n8n JSON templates, sample payloads, and integration documentation.
// This package provides reusable n8n sub-workflows and event type definitions.

export const N8N_VERSION = "1.0.0";

/** Fixed n8n version these workflows were tested with. */
export const N8N_TARGET_VERSION = "2.0.0";

export const WORKFLOW_FILES = {
  LEAD_QUALIFICATION_MAIN: "lead-qualification-main.json",
  EMIT_BUSINESS_EVENT: "emit-business-event.json",
  REQUEST_HUMAN_APPROVAL: "request-human-approval.json",
  GLOBAL_ERROR_HANDLER: "global-error-handler.json",
} as const;

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function loadWorkflow(name: string): Record<string, unknown> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(__dirname, "..", name);
  const content = readFileSync(filePath, "utf-8");
  return JSON.parse(content) as Record<string, unknown>;
}

export function loadLeadQualificationMain(): Record<string, unknown> {
  return loadWorkflow(WORKFLOW_FILES.LEAD_QUALIFICATION_MAIN);
}

export function loadEmitBusinessEvent(): Record<string, unknown> {
  return loadWorkflow(WORKFLOW_FILES.EMIT_BUSINESS_EVENT);
}

export function loadRequestHumanApproval(): Record<string, unknown> {
  return loadWorkflow(WORKFLOW_FILES.REQUEST_HUMAN_APPROVAL);
}

export function loadGlobalErrorHandler(): Record<string, unknown> {
  return loadWorkflow(WORKFLOW_FILES.GLOBAL_ERROR_HANDLER);
}
