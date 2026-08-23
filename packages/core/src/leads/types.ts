import { z } from "zod";

export const LEAD_STATUSES = [
  "received",
  "qualified",
  "needs_review",
  "approved",
  "rejected",
  "converted",
  "archived",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_COMMANDS = [
  "qualify",
  "needs_review",
  "approve",
  "reject",
  "convert",
  "archive",
] as const;
export type LeadCommand = (typeof LEAD_COMMANDS)[number];

export const SUGGESTED_NEXT_ACTIONS = [
  "request_approval",
  "book_call",
  "send_nurture",
  "discard",
] as const;
export type SuggestedNextAction = (typeof SUGGESTED_NEXT_ACTIONS)[number];

export type QualificationDecision = "qualified" | "needs_review" | "disqualified";

export const QUALIFICATION_DECISIONS: Record<string, QualificationDecision> = {
  qualified: "qualified",
  needs_review: "needs_review",
  disqualified: "disqualified",
};

const riskFlagSchema = z.string().min(1).max(100);

export const leadQualificationSchema = z.object({
  schemaVersion: z.literal(1),
  score: z.number().int().min(0).max(100),
  decision: z.enum(["qualified", "needs_review", "disqualified"]),
  reasons: z.array(z.string().min(1).max(300)).min(1).max(5),
  summary: z.string().min(1).max(500),
  suggestedNextAction: z.enum([
    "request_approval",
    "book_call",
    "send_nurture",
    "discard",
  ]),
  confidence: z.number().min(0).max(1),
  riskFlags: z.array(riskFlagSchema).max(20),
}).strict();

export type LeadQualification = z.infer<typeof leadQualificationSchema>;

export interface QualificationInput {
  contactName: string;
  email: string;
  phone: string;
  company: string;
  message: string;
  source: string;
  serviceNeeded: string;
}

export interface QualificationProviderRequest {
  systemMessage: string;
  userMessage: string;
  timeoutMs: number;
}

export interface QualificationProviderResponse {
  /** Untrusted structured model output; the core handler validates it. */
  qualification: unknown;
  usage?: { input: number; output: number };
  /** Cost in the currency's minor unit (for USD, integer cents). */
  cost?: { amountMinor: number; currency: string };
}

export interface QualificationProvider {
  qualify(
    input: QualificationInput,
    context: { leadId: string; organizationId: string; clientId: string },
    request: QualificationProviderRequest,
  ): Promise<QualificationProviderResponse>;
}

export interface QualificationError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface AIProviderResult {
  qualification?: LeadQualification;
  error?: QualificationError;
  metadata: {
    provider: string;
    model: string;
    promptVersion: string;
    inputHash: string;
    tokens?: { input: number; output: number };
    cost?: { amountMinor: number; currency: string };
    latencyMs: number;
  };
}

export interface AIRunRecord {
  id: string;
  organizationId: string;
  clientId: string;
  leadId: string;
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  result: LeadQualification | null;
  tokens: { input: number; output: number } | null;
  cost: { amountMinor: number; currency: string } | null;
  latencyMs: number;
  status: string;
  errorClassification: string | null;
  createdAt: string;
}

export interface DedupeKey {
  version: number;
  key: string;
}

export const DEDUPE_VERSION = 1;
const DV = String(DEDUPE_VERSION);

export function normalizeEmail(email: string | null | undefined): string {
  if (!email) return "";
  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.replace(/[^+\d]/g, "");
}

export function normalizeCompany(company: string | null | undefined): string {
  if (!company) return "";
  return company.trim();
}

export function computeDedupeKey(input: {
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  externalId?: string | null;
}): DedupeKey {
  if (input.externalId && input.source) {
    return {
      version: DEDUPE_VERSION,
      key: `${DV}:ext:${input.source}:${input.externalId}`,
    };
  }
  const e = normalizeEmail(input.email);
  const p = normalizePhone(input.phone);
  const source = input.source ?? "unknown";
  if (e || p) {
    const parts = [DV, "dedupe", source];
    if (e) parts.push(e);
    if (p) parts.push(p);
    return { version: DEDUPE_VERSION, key: parts.join(":") };
  }
  // No identifiable fields: use a random UUID-based key to prevent
  // all unidentifiable leads from colliding on a single `1:none` row.
  // This is a non-deduplicable path — each such event produces a new lead.
  return {
    version: DEDUPE_VERSION,
    key: `${DV}:none:${cryptoRandomUUID()}`,
  };
}

function cryptoRandomUUID(): string {
  // Use crypto.randomUUID when available, fallback for older Node
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Simple fallback for environments without crypto.randomUUID
  const hex = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
  return hex;
}

export interface LeadRecord {
  id: string;
  organizationId: string;
  clientId: string;
  source: string;
  externalId: string | null;
  dedupeKey: string;
  dedupeVersion: number;
  status: LeadStatus;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  message: string | null;
  score: number | null;
  qualificationDecision: QualificationDecision | null;
  qualificationSummary: string | null;
  qualificationConfidence: number | null;
  suggestedNextAction: string | null;
  metadata: Record<string, unknown> | null;
  receivedAt: string | null;
  qualifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const qualificationDecisionToStatus: Record<
  QualificationDecision,
  LeadStatus
> = {
  qualified: "qualified",
  needs_review: "needs_review",
  disqualified: "archived",
};
