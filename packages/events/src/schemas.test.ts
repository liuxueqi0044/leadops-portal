import { describe, it, expect } from "vitest";
import {
  baseEventSchema,
  eventSchema,
  envelopeOnlySchema,
  parseEnvelope,
  parseEvent,
  EVENT_TYPES,
  SPEC_VERSION,
} from "../src/schemas.js";

describe("Event Schemas", () => {
  const basePayload = {
    specVersion: "1.0",
    eventId: "00000000-0000-0000-0000-000000000001",
    eventType: "workflow.run.started",
    occurredAt: "2026-08-06T12:00:00.000Z",
    source: "n8n",
    organizationId: "00000000-0000-0000-0000-000000000010",
    clientId: "00000000-0000-0000-0000-000000000020",
    workflow: {
      id: "wf-test-1",
      name: "Test Workflow",
    },
    run: {
      id: "run-test-1",
    },
    data: {
      input: { test: true },
    },
    metadata: {
      schemaVersion: "1.0",
      correlationId: "corr-123",
    },
  };

  describe("baseEventSchema", () => {
    it("parses a valid event", () => {
      const result = baseEventSchema.parse(basePayload);
      expect(result.specVersion).toBe("1.0");
      expect(result.eventId).toBe("00000000-0000-0000-0000-000000000001");
    });

    it("rejects specVersion != 1.0", () => {
      expect(() =>
        baseEventSchema.parse({ ...basePayload, specVersion: "2.0" }),
      ).toThrow();
    });

    it("rejects invalid UUID eventId", () => {
      expect(() =>
        baseEventSchema.parse({ ...basePayload, eventId: "not-a-uuid" }),
      ).toThrow();
    });

    it("rejects invalid datetime occurredAt", () => {
      expect(() =>
        baseEventSchema.parse({ ...basePayload, occurredAt: "not-a-date" }),
      ).toThrow();
    });

    it("rejects empty source", () => {
      expect(() =>
        baseEventSchema.parse({ ...basePayload, source: "" }),
      ).toThrow();
    });

    it("requires metadata.schemaVersion", () => {
      expect(() =>
        baseEventSchema.parse({
          ...basePayload,
          metadata: { correlationId: "x" },
        }),
      ).toThrow();
    });
  });

  describe("envelopeOnlySchema", () => {
    it("accepts unknown eventType strings", () => {
      const result = envelopeOnlySchema.parse({
        ...basePayload,
        eventType: "unknown.event.type",
      });
      expect(result.eventType).toBe("unknown.event.type");
    });

  it("rejects missing eventType", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { eventType: _unused, ...rest } = basePayload;
      expect(() => envelopeOnlySchema.parse(rest)).toThrow();
    });
  });

  describe("discriminated union (eventSchema)", () => {
    it("parses workflow.run.started", () => {
      const result = eventSchema.parse(basePayload);
      expect(result.eventType).toBe("workflow.run.started");
    });

    it("parses workflow.run.succeeded", () => {
      const result = eventSchema.parse({
        ...basePayload,
        eventType: "workflow.run.succeeded",
        data: { output: { result: "ok" } },
      });
      expect(result.eventType).toBe("workflow.run.succeeded");
    });

    it("parses workflow.run.failed", () => {
      const result = eventSchema.parse({
        ...basePayload,
        eventType: "workflow.run.failed",
        data: { error: { message: "Something broke", code: "ERR_1" } },
      });
      expect(result.eventType).toBe("workflow.run.failed");
    });

    it("parses lead.received", () => {
      const result = eventSchema.parse({
        ...basePayload,
        eventType: "lead.received",
        workflow: undefined,
        run: undefined,
        data: { lead: { name: "John", email: "john@test.com" } },
      });
      expect(result.eventType).toBe("lead.received");
    });

    it("parses lead.qualified", () => {
      const result = eventSchema.parse({
        ...basePayload,
        eventType: "lead.qualified",
        workflow: undefined,
        run: undefined,
        data: { leadId: "lead-1", qualification: { score: 95 } },
      });
      expect(result.eventType).toBe("lead.qualified");
    });

    it("parses approval.requested", () => {
      const result = eventSchema.parse({
        ...basePayload,
        eventType: "approval.requested",
        workflow: undefined,
        run: undefined,
        data: { approvalId: "apr-1", leadId: "lead-1", requestedBy: "user-1" },
      });
      expect(result.eventType).toBe("approval.requested");
    });

    it("parses approval.completed", () => {
      const result = eventSchema.parse({
        ...basePayload,
        eventType: "approval.completed",
        workflow: undefined,
        run: undefined,
        data: { approvalId: "apr-1", leadId: "lead-1", decision: "approved" },
      });
      expect(result.eventType).toBe("approval.completed");
    });

    it("parses appointment.booked", () => {
      const result = eventSchema.parse({
        ...basePayload,
        eventType: "appointment.booked",
        workflow: undefined,
        run: undefined,
        data: {
          leadId: "lead-1",
          appointmentId: "apt-1",
          scheduledAt: "2026-08-07T10:00:00.000Z",
        },
      });
      expect(result.eventType).toBe("appointment.booked");
    });

    it("rejects unknown eventType in discriminated union", () => {
      expect(() =>
        eventSchema.parse({ ...basePayload, eventType: "unknown.type" }),
      ).toThrow();
    });
  });

  describe("parseEnvelope", () => {
    it("parses any eventType string", () => {
      const result = parseEnvelope({ ...basePayload, eventType: "custom.event" });
      expect(result.eventType).toBe("custom.event");
      expect(result.specVersion).toBe("1.0");
    });
  });

  describe("parseEvent", () => {
    it("parses known eventType", () => {
      const result = parseEvent(basePayload);
      expect(result.eventType).toBe("workflow.run.started");
    });

    it("throws for unknown eventType", () => {
      expect(() =>
        parseEvent({ ...basePayload, eventType: "unknown.type" }),
      ).toThrow();
    });
  });

  describe("EVENT_TYPES", () => {
    it("contains all 8 event types", () => {
      expect(EVENT_TYPES).toHaveLength(8);
    });

    it("contains workflow.run.* types", () => {
      expect(EVENT_TYPES).toContain("workflow.run.started");
      expect(EVENT_TYPES).toContain("workflow.run.succeeded");
      expect(EVENT_TYPES).toContain("workflow.run.failed");
    });

    it("contains lead.* types", () => {
      expect(EVENT_TYPES).toContain("lead.received");
      expect(EVENT_TYPES).toContain("lead.qualified");
    });

    it("contains approval.* types", () => {
      expect(EVENT_TYPES).toContain("approval.requested");
      expect(EVENT_TYPES).toContain("approval.completed");
    });

    it("contains appointment type", () => {
      expect(EVENT_TYPES).toContain("appointment.booked");
    });
  });

  describe("SPEC_VERSION", () => {
    it("is 1.0", () => {
      expect(SPEC_VERSION).toBe("1.0");
    });
  });
});
