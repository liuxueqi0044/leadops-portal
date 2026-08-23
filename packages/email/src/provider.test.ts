import { describe, expect, it } from "vitest";
import { createFakeEmailProvider, isSendResultRetryable } from "./provider.js";

describe("Fake Email Provider", () => {
  it("returns ok by default", async () => {
    const provider = createFakeEmailProvider();
    const result = await provider.send({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Hello</p>",
      textBody: "Hello",
      idempotencyKey: "key-1",
      templateName: "test",
    });
    expect(result.ok).toBe(true);
    expect(result.providerMessageId).toContain("fake-msg-key-1");
    expect(result.retryable).toBe(false);
  });

  it("returns retryable failure when configured", async () => {
    const provider = createFakeEmailProvider({ shouldFail: "retryable" });
    const result = await provider.send({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Hello</p>",
      textBody: "Hello",
      idempotencyKey: "key-2",
      templateName: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("429");
  });

  it("returns permanent failure when configured", async () => {
    const provider = createFakeEmailProvider({ shouldFail: "permanent" });
    const result = await provider.send({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Hello</p>",
      textBody: "Hello",
      idempotencyKey: "key-3",
      templateName: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain("400");
  });

  it("returns timeout failure when configured", async () => {
    const provider = createFakeEmailProvider({ shouldFail: "timeout" });
    const result = await provider.send({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Hello</p>",
      textBody: "Hello",
      idempotencyKey: "key-4",
      templateName: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("timeout");
  });

  it("isSendResultRetryable identifies retryable results", () => {
    expect(isSendResultRetryable({ ok: true, retryable: false })).toBe(false);
    expect(isSendResultRetryable({ ok: false, retryable: true, error: "timeout" })).toBe(true);
    expect(isSendResultRetryable({ ok: false, retryable: false, error: "bad request" })).toBe(false);
  });

  it("supports simulated latency", async () => {
    const provider = createFakeEmailProvider({ latencyMs: 10 });
    const start = Date.now();
    await provider.send({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Hello</p>",
      textBody: "Hello",
      idempotencyKey: "key-5",
      templateName: "test",
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
  });
});
