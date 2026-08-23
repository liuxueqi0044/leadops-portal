import { describe, it, expect } from "vitest";
import {
  generateApprovalToken,
  hashToken,
  constantTimeCompareToken,
  redactToken,
} from "@leadops/core";

describe("approval tokens", () => {
  describe("generateApprovalToken", () => {
    it("generates a token pair with plaintext and hash", () => {
      const pair = generateApprovalToken();
      expect(pair.plaintext).toBeTruthy();
      expect(pair.hash).toBeTruthy();
      expect(pair.plaintext.length).toBeGreaterThanOrEqual(32);
      expect(pair.hash.length).toBe(64); // SHA-256 hex = 64 chars
    });

    it("generates unique tokens each time", () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateApprovalToken().plaintext);
      }
      expect(tokens.size).toBe(100);
    });

    it("plaintext uses base64url characters", () => {
      const pair = generateApprovalToken();
      expect(pair.plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("hash matches the plaintext", () => {
      const pair = generateApprovalToken();
      const computedHash = hashToken(pair.plaintext);
      expect(computedHash).toBe(pair.hash);
    });
  });

  describe("hashToken", () => {
    it("produces deterministic SHA-256 hashes", () => {
      const hash1 = hashToken("test-token");
      const hash2 = hashToken("test-token");
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different inputs", () => {
      const hash1 = hashToken("token-a");
      const hash2 = hashToken("token-b");
      expect(hash1).not.toBe(hash2);
    });

    it("produces 64-character hex string", () => {
      const hash = hashToken("anything");
      expect(hash.length).toBe(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe("constantTimeCompareToken", () => {
    it("returns true for equal strings", () => {
      expect(constantTimeCompareToken("abc", "abc")).toBe(true);
    });

    it("returns false for different strings same length", () => {
      expect(constantTimeCompareToken("abc", "abd")).toBe(false);
    });

    it("returns false for different length strings", () => {
      expect(constantTimeCompareToken("abc", "abcd")).toBe(false);
    });

    it("returns false for empty vs non-empty", () => {
      expect(constantTimeCompareToken("", "a")).toBe(false);
    });

    it("works with token-length strings", () => {
      const pair = generateApprovalToken();
      expect(constantTimeCompareToken(pair.hash, hashToken(pair.plaintext))).toBe(
        true,
      );
    });
  });

  describe("redactToken", () => {
    it("redacts short tokens", () => {
      expect(redactToken("short")).toBe("****");
    });

    it("redacts long tokens showing first 4 and last 4", () => {
      const pair = generateApprovalToken();
      const redacted = redactToken(pair.plaintext);
      expect(redacted).toContain("...");
      expect(redacted).not.toBe(pair.plaintext);
      expect(redacted.startsWith(pair.plaintext.slice(0, 4))).toBe(true);
    });

    it("does not contain full token", () => {
      const pair = generateApprovalToken();
      const redacted = redactToken(pair.plaintext);
      expect(redacted).not.toBe(pair.plaintext);
      expect(redacted.length).toBeLessThan(pair.plaintext.length);
      expect(pair.plaintext.includes(redacted)).toBe(false);
    });
  });
});
