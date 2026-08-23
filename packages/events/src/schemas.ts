import { z } from "zod";

export const SPEC_VERSION = "1.0" as const;
export const EVENTS_VERSION = "1.0.0";

export const EVENT_TYPES = [
  "workflow.run.started",
  "workflow.run.succeeded",
  "workflow.run.failed",
  "lead.received",
  "lead.qualified",
  "approval.requested",
  "approval.completed",
  "appointment.booked",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const baseEventSchema = z.object({
  specVersion: z.literal(SPEC_VERSION),
  eventId: z.string().uuid(),
  eventType: z.enum(EVENT_TYPES),
  occurredAt: z.string().datetime(),
  source: z.string().min(1),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  workflow: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
    })
    .optional(),
  run: z
    .object({
      id: z.string().min(1),
    })
    .optional(),
  data: z.record(z.unknown()).default({}),
  metadata: z.object({
    schemaVersion: z.string(),
    correlationId: z.string().optional(),
  }),
});

export type BaseEvent = z.infer<typeof baseEventSchema>;

export const workflowRunStartedEventSchema = baseEventSchema.extend({
  eventType: z.literal("workflow.run.started"),
  workflow: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
  }),
  run: z.object({
    id: z.string().min(1),
  }),
  data: z.object({
    input: z.unknown().optional(),
  }).optional(),
});

export const workflowRunSucceededEventSchema = baseEventSchema.extend({
  eventType: z.literal("workflow.run.succeeded"),
  workflow: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
  }),
  run: z.object({
    id: z.string().min(1),
  }),
  data: z.object({
    output: z.unknown().optional(),
  }).optional(),
});

export const workflowRunFailedEventSchema = baseEventSchema.extend({
  eventType: z.literal("workflow.run.failed"),
  workflow: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
  }),
  run: z.object({
    id: z.string().min(1),
  }),
  data: z.object({
    error: z.object({
      message: z.string(),
      code: z.string().optional(),
    }).optional(),
  }).optional(),
});

export const leadReceivedEventSchema = baseEventSchema.extend({
  eventType: z.literal("lead.received"),
  data: z.object({
    lead: z.record(z.unknown()),
  }),
});

export const leadQualifiedEventSchema = baseEventSchema.extend({
  eventType: z.literal("lead.qualified"),
  data: z.object({
    leadId: z.string(),
    qualification: z.record(z.unknown()).optional(),
  }),
});

export const approvalRequestedEventSchema = baseEventSchema.extend({
  eventType: z.literal("approval.requested"),
  data: z.object({
    approvalId: z.string(),
    leadId: z.string().optional(),
    requestedBy: z.string().optional(),
  }),
});

export const approvalCompletedEventSchema = baseEventSchema.extend({
  eventType: z.literal("approval.completed"),
  data: z.object({
    approvalId: z.string(),
    leadId: z.string().optional(),
    decision: z.enum(["approved", "rejected"]),
  }),
});

export const appointmentBookedEventSchema = baseEventSchema.extend({
  eventType: z.literal("appointment.booked"),
  data: z.object({
    leadId: z.string(),
    appointmentId: z.string().optional(),
    scheduledAt: z.string().datetime().optional(),
  }),
});

export const eventSchema = z.discriminatedUnion("eventType", [
  workflowRunStartedEventSchema,
  workflowRunSucceededEventSchema,
  workflowRunFailedEventSchema,
  leadReceivedEventSchema,
  leadQualifiedEventSchema,
  approvalRequestedEventSchema,
  approvalCompletedEventSchema,
  appointmentBookedEventSchema,
]);

export type WorkflowRunStartedEvent = z.infer<typeof workflowRunStartedEventSchema>;
export type WorkflowRunSucceededEvent = z.infer<typeof workflowRunSucceededEventSchema>;
export type WorkflowRunFailedEvent = z.infer<typeof workflowRunFailedEventSchema>;
export type LeadReceivedEvent = z.infer<typeof leadReceivedEventSchema>;
export type LeadQualifiedEvent = z.infer<typeof leadQualifiedEventSchema>;
export type ApprovalRequestedEvent = z.infer<typeof approvalRequestedEventSchema>;
export type ApprovalCompletedEvent = z.infer<typeof approvalCompletedEventSchema>;
export type AppointmentBookedEvent = z.infer<typeof appointmentBookedEventSchema>;
export type Event = z.infer<typeof eventSchema>;

export const envelopeOnlySchema = baseEventSchema.extend({
  eventType: z.string(),
});

export type EnvelopeOnly = z.infer<typeof envelopeOnlySchema>;

export function parseEnvelope(payload: unknown): EnvelopeOnly {
  return envelopeOnlySchema.parse(payload);
}

export function parseEvent(payload: unknown): Event {
  return eventSchema.parse(payload);
}
