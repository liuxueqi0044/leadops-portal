import type { LeadStatus, LeadCommand } from "./types.js";
import { LEAD_STATUSES } from "./types.js";

interface Transition {
  from: LeadStatus[];
  to: LeadStatus;
}

export type StateMachineErrorCode =
  | "INVALID_TRANSITION"
  | "TERMINAL_STATUS"
  | "ILLEGAL_COMMAND";

export class StateMachineError extends Error {
  constructor(
    message: string,
    public readonly code: StateMachineErrorCode,
    public readonly from: LeadStatus,
    public readonly command: LeadCommand,
    public readonly attemptedTo: LeadStatus | null,
  ) {
    super(message);
    this.name = "StateMachineError";
  }
}

const VALID_TRANSITIONS: Record<LeadCommand, Transition> = {
  qualify: {
    from: ["received"],
    to: "qualified",
  },
  needs_review: {
    from: ["received"],
    to: "needs_review",
  },
  approve: {
    from: ["qualified", "needs_review"],
    to: "approved",
  },
  reject: {
    from: ["qualified", "needs_review"],
    to: "rejected",
  },
  convert: {
    from: ["approved"],
    to: "converted",
  },
  archive: {
    from: ["received", "qualified", "needs_review", "approved", "rejected"],
    to: "archived",
  },
};

const TERMINAL_STATUSES: LeadStatus[] = ["converted", "archived"];

export function canTransition(
  from: LeadStatus,
  command: LeadCommand,
): { allowed: true; to: LeadStatus } | { allowed: false; reason: string } {
  const transition = VALID_TRANSITIONS[command];

  if (TERMINAL_STATUSES.includes(from)) {
    return {
      allowed: false,
      reason: `Cannot transition from terminal status: ${from}`,
    };
  }

  if (!transition.from.includes(from)) {
    return {
      allowed: false,
      reason: `Command '${command}' not allowed from status '${from}'. Allowed from: ${transition.from.join(", ")}`,
    };
  }

  return { allowed: true, to: transition.to };
}

export function transitionOrThrow(
  from: LeadStatus,
  command: LeadCommand,
): LeadStatus {
  const result = canTransition(from, command);
  if (!result.allowed) {
    throw new StateMachineError(
      result.reason,
      "INVALID_TRANSITION",
      from,
      command,
      null,
    );
  }
  return result.to;
}

export function isTerminal(status: LeadStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function assertIsValidStatus(status: string): asserts status is LeadStatus {
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
    throw new StateMachineError(
      `Unknown status: ${status}`,
      "ILLEGAL_COMMAND",
      "received",
      "archive",
      null,
    );
  }
}

export function getLegalCommands(status: LeadStatus): LeadCommand[] {
  if (isTerminal(status)) return [];
  return (Object.entries(VALID_TRANSITIONS) as [LeadCommand, Transition][])
    .filter(([, t]) => t.from.includes(status))
    .map(([cmd]) => cmd);
}

export function canApplyQualificationDecision(
  _from: LeadStatus,
  decision: "qualified" | "needs_review" | "disqualified",
): LeadCommand {
  switch (decision) {
    case "qualified":
      return "qualify";
    case "needs_review":
      return "needs_review";
    case "disqualified":
      return "archive";
  }
}
