export {
  LEAD_STATUSES,
  LEAD_COMMANDS,
  SUGGESTED_NEXT_ACTIONS,
  QUALIFICATION_DECISIONS,
  leadQualificationSchema,
  qualificationDecisionToStatus,
  DEDUPE_VERSION,
  normalizeEmail,
  normalizePhone,
  normalizeCompany,
  computeDedupeKey,
} from "./types.js";
export type {
  LeadStatus,
  LeadCommand,
  SuggestedNextAction,
  QualificationDecision,
  LeadQualification,
  QualificationInput,
  QualificationProviderRequest,
  QualificationProviderResponse,
  QualificationProvider,
  QualificationError,
  AIProviderResult,
  AIRunRecord,
  DedupeKey,
  LeadRecord,
} from "./types.js";
export {
  StateMachineError,
  canTransition,
  transitionOrThrow,
  isTerminal,
  assertIsValidStatus,
  getLegalCommands,
  canApplyQualificationDecision,
} from "./state-machine.js";
export type { StateMachineErrorCode } from "./state-machine.js";
export {
  createDeterministicFakeProvider,
  fakeProvider,
} from "./fake-provider.js";
export {
  PROMPT_VERSION,
  createLeadQualificationPrompt,
} from "./prompt.js";
export type { PromptTemplate } from "./prompt.js";
export {
  runQualification,
  runQualificationOrNeedsReview,
} from "./qualification-handler.js";
export type { QualificationHandlerOptions } from "./qualification-handler.js";
