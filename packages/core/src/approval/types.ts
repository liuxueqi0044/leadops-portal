import { z } from "zod";

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const APPROVAL_COMMANDS = [
  "approval.requested",
  "decide",
  "decide_public",
  "expire",
  "cancel",
] as const;

export type ApprovalCommand = (typeof APPROVAL_COMMANDS)[number];

/** Terminal statuses: no further transitions allowed. */
export function isApprovalTerminal(status: ApprovalStatus): boolean {
  return ["approved", "rejected", "expired", "cancelled"].includes(status);
}

/** Legal state transitions for the approval state machine. */
const APPROVAL_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  pending: ["approved", "rejected", "expired", "cancelled"],
  approved: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

/** Check if a transition from one status to another is allowed. */
export function canTransitionApproval(
  from: ApprovalStatus,
  to: ApprovalStatus,
): boolean {
  const legal: readonly ApprovalStatus[] = APPROVAL_TRANSITIONS[from];
  return legal.includes(to);
}

/** Assert a transition is valid, throwing on illegal transitions. */
export function assertCanTransitionApproval(
  from: ApprovalStatus,
  to: ApprovalStatus,
): void {
  if (!canTransitionApproval(from, to)) {
    throw new ApprovalStateMachineError(
      `Cannot transition approval from '${from}' to '${to}'`,
      "ILLEGAL_TRANSITION",
    );
  }
}

export class ApprovalStateMachineError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ApprovalStateMachineError";
  }
}

export interface ApprovalSnapshot {
  leadId?: string | null;
  contactName?: string | null;
  company?: string | null;
  message?: string | null;
  score?: number | null;
  qualificationSummary?: string | null;
  qualificationDecision?: string | null;
  suggestedNextAction?: string | null;
}

export const approvalSnapshotSchema = z.object({
  leadId: z.string().uuid().optional().nullable(),
  contactName: z.string().optional().nullable(),
  company: z.string().optional().nullable(),
  message: z.string().optional().nullable(),
  score: z.number().int().min(0).max(100).optional().nullable(),
  qualificationSummary: z.string().optional().nullable(),
  qualificationDecision: z.string().optional().nullable(),
  suggestedNextAction: z.string().optional().nullable(),
}).strict();

export interface ApprovalRecord {
  id: string;
  organizationId: string;
  clientId: string;
  leadId: string | null;
  correlationId: string | null;
  requestVersion: string | null;
  status: ApprovalStatus;
  snapshot: ApprovalSnapshot;
  expiresAt: string;
  version: number;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
