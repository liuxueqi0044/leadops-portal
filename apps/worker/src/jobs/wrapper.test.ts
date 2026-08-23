import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Logger } from "pino";
import type postgres from "postgres";
import { createJobWrapper, JobError } from "./wrapper.js";
import { getJob } from "./registry.js";
import type { JobContext } from "./types.js";

function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function mockSql(): postgres.Sql {
  const innerUnsafe = vi.fn().mockResolvedValue([{ allowed: true }]);
  const begin = vi.fn().mockImplementation((callback: (tx: unknown) => Promise<unknown>) => {
    const tx = { unsafe: innerUnsafe } as unknown as postgres.Sql;
    return callback(tx);
  });
  const mock = innerUnsafe as unknown as postgres.Sql;
  (mock as unknown as Record<string, unknown>).begin = begin;
  return mock;
}

describe("Job Wrapper", () => {
  let logger: Logger;
  let sql: postgres.Sql;

  beforeEach(() => {
    logger = mockLogger();
    sql = mockSql();
  });

  it("throws JobError for unknown job name", async () => {
    const wrapper = createJobWrapper({ logger, sql });
    try {
      await wrapper.execute("unknown.job", {}, { jobId: "j1", attempt: 0 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("throws PERMANENT JobError for disabled job", async () => {
    const wrapper = createJobWrapper({ logger, sql });
    try {
      await wrapper.execute(
        "retention.prune-non-audit-data",
        { schemaVersion: 1 },
        { jobId: "j1", attempt: 0 },
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).code).toBe("PERMANENT");
    }
  });

  it("throws INVALID_PAYLOAD for wrong schemaVersion", async () => {
    const def = getJob("events.project");
    if (def) def.handler = vi.fn().mockResolvedValue(undefined);
    const wrapper = createJobWrapper({ logger, sql });
    try {
      await wrapper.execute("events.project", { schemaVersion: 999 }, { jobId: "j1", attempt: 0 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("throws INVALID_PAYLOAD for Zod schema violation", async () => {
    const wrapper = createJobWrapper({ logger, sql });
    try {
      await wrapper.execute(
        "emails.send",
        { schemaVersion: 1, deliveryId: "not-a-uuid" },
        { jobId: "j1", attempt: 0 },
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("throws INVALID_PAYLOAD for tenant job missing orgId", async () => {
    const def = getJob("events.project");
    if (def) def.handler = vi.fn().mockResolvedValue(undefined);
    const wrapper = createJobWrapper({ logger, sql });
    try {
      await wrapper.execute(
        "events.project",
        {
          schemaVersion: 1,
          eventId: "00000000-0000-0000-0000-000000000001",
          eventType: "test",
          integrationId: "00000000-0000-0000-0000-000000000002",
          clientId: "00000000-0000-0000-0000-000000000003",
        },
        { jobId: "j1", attempt: 0 },
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("returns success for valid enabled job", async () => {
    const handlerCalled = vi.fn().mockResolvedValue(undefined);
    const def = getJob("emails.send");
    if (def) def.handler = handlerCalled;
    const wrapper = createJobWrapper({ logger, sql });
    const result = await wrapper.execute(
      "emails.send",
      {
        schemaVersion: 1,
        deliveryId: "00000000-0000-0000-0000-000000000001",
        organizationId: "00000000-0000-0000-0000-000000000002",
        clientId: "00000000-0000-0000-0000-000000000003",
        integrationId: "00000000-0000-0000-0000-000000000004",
        correlationId: "corr-1",
      },
      { jobId: "j1", attempt: 0 },
    );
    expect(handlerCalled).toHaveBeenCalledTimes(1);
    expect(result.result).toBe("success");
    expect(result.correlationId).toBe("corr-1");
  });

  it("returns RETRYABLE for timeout errors", async () => {
    const def = getJob("emails.send");
    if (def) {
      def.handler = vi.fn().mockRejectedValue(Object.assign(new Error("Timed out"), { name: "TimeoutError" }));
    }
    const wrapper = createJobWrapper({ logger, sql });
    try {
      await wrapper.execute(
        "emails.send",
        {
          schemaVersion: 1,
          deliveryId: "00000000-0000-0000-0000-000000000001",
          organizationId: "00000000-0000-0000-0000-000000000002",
          clientId: "00000000-0000-0000-0000-000000000003",
          integrationId: "00000000-0000-0000-0000-000000000004",
        },
        { jobId: "j1", attempt: 0 },
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).code).toBe("TIMEOUT");
    }
  });

  it("enforces the configured timeout when a handler does not settle", async () => {
    const def = getJob("emails.send");
    if (!def) throw new Error("emails.send job is missing");
    const originalHandler = def.handler;
    const originalTimeout = def.timeout;
    let receivedSignal: AbortSignal | undefined;
    def.timeout = 5;
    def.handler = vi.fn().mockImplementation((_payload: unknown, context: JobContext) => {
      receivedSignal = context.signal;
      return new Promise<void>(() => undefined);
    });

    const wrapper = createJobWrapper({ logger, sql });
    await expect(
      wrapper.execute(
        "emails.send",
        {
          schemaVersion: 1,
          deliveryId: "00000000-0000-0000-0000-000000000001",
          organizationId: "00000000-0000-0000-0000-000000000002",
          clientId: "00000000-0000-0000-0000-000000000003",
          integrationId: "00000000-0000-0000-0000-000000000004",
        },
        { jobId: "timeout-job", attempt: 0 },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(receivedSignal?.aborted).toBe(true);

    def.handler = originalHandler;
    def.timeout = originalTimeout;
  });

  it("returns PERMANENT for PermanentEmailError", async () => {
    const def = getJob("emails.send");
    if (def) {
      def.handler = vi.fn().mockRejectedValue(Object.assign(new Error("Bad request"), { name: "PermanentEmailError" }));
    }
    const wrapper = createJobWrapper({ logger, sql });
    try {
      await wrapper.execute(
        "emails.send",
        {
          schemaVersion: 1,
          deliveryId: "00000000-0000-0000-0000-000000000001",
          organizationId: "00000000-0000-0000-0000-000000000002",
          clientId: "00000000-0000-0000-0000-000000000003",
          integrationId: "00000000-0000-0000-0000-000000000004",
        },
        { jobId: "j1", attempt: 0 },
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).code).toBe("PERMANENT");
    }
  });

  it("calls incident escalation on permanent failure at threshold", async () => {
    const onIncident = vi.fn();
    const def = getJob("emails.send");
    if (def) {
      def.handler = vi.fn().mockRejectedValue(Object.assign(new Error("Bad request"), { name: "PermanentEmailError" }));
    }
    const wrapper = createJobWrapper({ logger, sql, onIncidentEscalation: onIncident });
    try {
      await wrapper.execute(
        "emails.send",
        {
          schemaVersion: 1,
          deliveryId: "00000000-0000-0000-0000-000000000001",
          organizationId: "00000000-0000-0000-0000-000000000002",
          clientId: "00000000-0000-0000-0000-000000000003",
          integrationId: "00000000-0000-0000-0000-000000000004",
        },
        { jobId: "j1", attempt: 5 },
      );
    } catch {
      // expected
    }
    expect(onIncident).toHaveBeenCalledTimes(1);
    const callArgs = (onIncident as unknown as { mock: { calls: [unknown][][] } }).mock.calls[0];
    const event = callArgs?.[0] as unknown as { jobName: string; errorCategory: string };
    expect(event.jobName).toBe("emails.send");
    expect(event.errorCategory).toBe("permanent");
  });

  it("propagates correlationId from payload", async () => {
    const def = getJob("emails.send");
    if (def) def.handler = vi.fn().mockResolvedValue(undefined);
    const wrapper = createJobWrapper({ logger, sql });
    const result = await wrapper.execute(
      "emails.send",
      {
        schemaVersion: 1,
        deliveryId: "00000000-0000-0000-0000-000000000001",
        organizationId: "00000000-0000-0000-0000-000000000002",
        clientId: "00000000-0000-0000-0000-000000000003",
        integrationId: "00000000-0000-0000-0000-000000000004",
        correlationId: "my-custom-correlation",
      },
      { jobId: "j2", attempt: 0 },
    );
    expect(result.correlationId).toBe("my-custom-correlation");
  });

  it("falls back to jobId for correlationId", async () => {
    const def = getJob("emails.send");
    if (def) def.handler = vi.fn().mockResolvedValue(undefined);
    const wrapper = createJobWrapper({ logger, sql });
    const result = await wrapper.execute(
      "emails.send",
      {
        schemaVersion: 1,
        deliveryId: "00000000-0000-0000-0000-000000000001",
        organizationId: "00000000-0000-0000-0000-000000000002",
        clientId: "00000000-0000-0000-0000-000000000003",
        integrationId: "00000000-0000-0000-0000-000000000004",
      },
      { jobId: "fallback-correlation", attempt: 0 },
    );
    expect(result.correlationId).toBe("fallback-correlation");
  });
});
