export type { Webhook } from "standardwebhooks";

export { EVENTS_VERSION } from "./schemas.js";
export {
  SPEC_VERSION,
  EVENT_TYPES,
  baseEventSchema,
  eventSchema,
  envelopeOnlySchema,
  parseEnvelope,
  parseEvent,
} from "./schemas.js";
export type {
  EventType,
  BaseEvent,
  EnvelopeOnly,
  Event,
  WorkflowRunStartedEvent,
  WorkflowRunSucceededEvent,
  WorkflowRunFailedEvent,
  LeadReceivedEvent,
  LeadQualifiedEvent,
  ApprovalRequestedEvent,
  ApprovalCompletedEvent,
  AppointmentBookedEvent,
} from "./schemas.js";
export {
  createWebhookSigner,
  verifyWebhookSignature,
  signWebhook,
  generateWebhookSecret,
  computeBodyHash,
  constantTimeCompare,
  WebhookVerificationError,
} from "./signing.js";
export type { SignResult } from "./signing.js";
export {
  ProjectorRegistry,
  createProjectorRegistry,
} from "./registry.js";
export type {
  ProjectorHandler,
  ProjectorContext,
  ProjectorResult,
} from "./registry.js";
