import { describe, expect, it } from "vitest";
import { classifyError, createBackoff } from "./errors.js";

describe("Error Classification", () => {
  it("classifies TimeoutError as timeout", () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    expect(classifyError(err)).toBe("timeout");
  });

  it("classifies AbortError as timeout", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(classifyError(err)).toBe("timeout");
  });

  it("classifies ZodError as invalid-payload", () => {
    const err = new Error("validation failed");
    err.name = "ZodError";
    expect(classifyError(err)).toBe("invalid-payload");
  });

  it("classifies ECONNREFUSED as retryable", () => {
    const err = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    expect(classifyError(err)).toBe("retryable");
  });

  it("classifies ECONNRESET as retryable", () => {
    const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(classifyError(err)).toBe("retryable");
  });

  it("classifies JOB_DISABLED as permanent", () => {
    const err = new Error("JOB_DISABLED");
    expect(classifyError(err)).toBe("permanent");
  });

  it("classifies TENANT_BINDING_MISMATCH as permanent", () => {
    const err = new Error("TENANT_BINDING_MISMATCH");
    expect(classifyError(err)).toBe("permanent");
  });

  it("classifies status 429 as retryable", () => {
    expect(classifyError({ statusCode: 429 })).toBe("retryable");
  });

  it("classifies status 503 as retryable", () => {
    expect(classifyError({ statusCode: 503 })).toBe("retryable");
  });

  it("classifies status 400 as permanent", () => {
    expect(classifyError({ statusCode: 400 })).toBe("permanent");
  });

  it("classifies status 404 as permanent", () => {
    expect(classifyError({ statusCode: 404 })).toBe("permanent");
  });

  it("defaults to retryable for unknown errors", () => {
    expect(classifyError(new Error("something unknown"))).toBe("retryable");
  });
});

describe("Exponential Backoff with Jitter", () => {
  it("produces deterministic results with fixed clock", () => {
    const clock = () => 500;
    const result = createBackoff(1, 5000, clock);
    expect(result).toBe(createBackoff(1, 5000, clock));
  });

  it("increases delay with attempt number", () => {
    const clock = () => 0;
    const delay1 = createBackoff(1, 5000, clock);
    const delay2 = createBackoff(2, 5000, clock);
    const delay3 = createBackoff(3, 5000, clock);
    expect(delay2).toBeGreaterThanOrEqual(delay1);
    expect(delay3).toBeGreaterThanOrEqual(delay2);
  });

  it("has exponential growth", () => {
    const clock = () => 0;
    const delay1 = createBackoff(1, 5000, clock);
    const delay3 = createBackoff(3, 5000, clock);
    const delay6 = createBackoff(6, 5000, clock);
    expect(delay3).toBeGreaterThan(delay1 + 1000);
    expect(delay6).toBeGreaterThan(delay3 + 1000);
  });

  it("caps exponent at 10", () => {
    const clock = () => 0;
    const delay10 = createBackoff(10, 5000, clock);
    const delay11 = createBackoff(11, 5000, clock);
    const delay20 = createBackoff(20, 5000, clock);
    expect(delay10).toBe(delay11);
    expect(delay10).toBe(delay20);
  });
});
