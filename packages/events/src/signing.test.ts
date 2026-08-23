import { describe, it, expect } from "vitest";
import { Webhook } from "standardwebhooks";
import { createHmac } from "node:crypto";
import {
  verifyWebhookSignature,
  signWebhook,
  generateWebhookSecret,
  computeBodyHash,
  constantTimeCompare,
} from "../src/signing.js";

const FIXED_SECRET = "whsec_MfKQ9r8G7qrjH6Z2wXp5vBn4cLm3sY1t";
const FIXED_MSG_ID = "msg_25d61ad9-7462-442e-b8e1-0ea7a7c3a0b3";
const FIXED_TIMESTAMP = new Date("2026-08-06T12:00:00.000Z");
const FIXED_SIGNATURE = "v1,ChERfumeH9Lh7Ia/9kn7QlLM71kKXFcYeapX64/5Mas=";
const FIXED_PAYLOAD = JSON.stringify({
  specVersion: "1.0",
  eventId: "00000000-0000-0000-0000-000000000001",
  eventType: "workflow.run.started",
  occurredAt: "2026-08-06T12:00:00.000Z",
  source: "n8n",
  organizationId: "00000000-0000-0000-0000-000000000010",
  clientId: "00000000-0000-0000-0000-000000000020",
  workflow: { id: "wf-1" },
  run: { id: "run-1" },
  data: {},
  metadata: { schemaVersion: "1.0" },
});

/**
 * Independent HMAC-SHA256 signer using Node.js crypto directly.
 * This is NOT the same code path as the Standard Webhooks library.
 */
function independentSign(
  secret: string,
  msgId: string,
  timestamp: Date,
  payload: string,
): string {
  // Strip whsec_ prefix and base64-decode (same as Standard Webhooks)
  const rawSecret = secret.startsWith("whsec_")
    ? secret.substring(6)
    : secret;
  const key = Buffer.from(rawSecret, "base64");

  const timestampSec = Math.floor(timestamp.getTime() / 1000);
  const toSign = `${msgId}.${String(timestampSec)}.${payload}`;

  const hmac = createHmac("sha256", key);
  hmac.update(toSign);
  const signature = hmac.digest("base64");

  return `v1,${signature}`;
}

describe("Webhook Signing", () => {
  describe("Fixed signature vectors (independent implementation)", () => {
    it("generates expected signature using independent HMAC-SHA256", () => {
      const signature = independentSign(
        FIXED_SECRET,
        FIXED_MSG_ID,
        FIXED_TIMESTAMP,
        FIXED_PAYLOAD,
      );
      expect(signature).toBe(FIXED_SIGNATURE);

      const wh = new Webhook(FIXED_SECRET);
      const libSignature = wh.sign(FIXED_MSG_ID, FIXED_TIMESTAMP, FIXED_PAYLOAD);
      expect(signature).toBe(libSignature);
    });

    it("verify succeeds with correct signature", () => {
      const signature = independentSign(
        FIXED_SECRET,
        FIXED_MSG_ID,
        FIXED_TIMESTAMP,
        FIXED_PAYLOAD,
      );

      const result = verifyWebhookSignature(
        Buffer.from(FIXED_PAYLOAD),
        {
          "webhook-id": FIXED_MSG_ID,
          "webhook-timestamp": String(Math.floor(FIXED_TIMESTAMP.getTime() / 1000)),
          "webhook-signature": signature,
        },
        [FIXED_SECRET],
        Number.MAX_SAFE_INTEGER,
      );

      expect(result.valid).toBe(true);
    });

    it("verify fails with wrong secret", () => {
      const signature = independentSign(
        FIXED_SECRET,
        FIXED_MSG_ID,
        FIXED_TIMESTAMP,
        FIXED_PAYLOAD,
      );

      const result = verifyWebhookSignature(
        Buffer.from(FIXED_PAYLOAD),
        {
          "webhook-id": FIXED_MSG_ID,
          "webhook-timestamp": String(Math.floor(FIXED_TIMESTAMP.getTime() / 1000)),
          "webhook-signature": signature,
        },
        ["whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa="],
        Number.MAX_SAFE_INTEGER,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe("No matching signature found");
    });

    it("any byte change to body causes signature failure", () => {
      const signature = independentSign(
        FIXED_SECRET,
        FIXED_MSG_ID,
        FIXED_TIMESTAMP,
        FIXED_PAYLOAD,
      );

      const tamperedPayload = FIXED_PAYLOAD.replace("workflow.run.started", "workflow.run.succeeded");

      const result = verifyWebhookSignature(
        Buffer.from(tamperedPayload),
        {
          "webhook-id": FIXED_MSG_ID,
          "webhook-timestamp": String(Math.floor(FIXED_TIMESTAMP.getTime() / 1000)),
          "webhook-signature": signature,
        },
        [FIXED_SECRET],
        Number.MAX_SAFE_INTEGER,
      );

      expect(result.valid).toBe(false);
    });
  });

  describe("Timestamp validation", () => {
    it("rejects old timestamp beyond tolerance", () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 min ago
      const signature = independentSign(
        FIXED_SECRET,
        FIXED_MSG_ID,
        new Date(oldTimestamp * 1000),
        FIXED_PAYLOAD,
      );

      const result = verifyWebhookSignature(
        Buffer.from(FIXED_PAYLOAD),
        {
          "webhook-id": FIXED_MSG_ID,
          "webhook-timestamp": String(oldTimestamp),
          "webhook-signature": signature,
        },
        [FIXED_SECRET],
        5 * 60 * 1000,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("old");
    });

    it("rejects future timestamp beyond tolerance", () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 600; // 10 min in future
      const signature = independentSign(
        FIXED_SECRET,
        FIXED_MSG_ID,
        new Date(futureTimestamp * 1000),
        FIXED_PAYLOAD,
      );

      const result = verifyWebhookSignature(
        Buffer.from(FIXED_PAYLOAD),
        {
          "webhook-id": FIXED_MSG_ID,
          "webhook-timestamp": String(futureTimestamp),
          "webhook-signature": signature,
        },
        [FIXED_SECRET],
        5 * 60 * 1000,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("new");
    });

    it("accepts current timestamp within tolerance", () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = independentSign(
        FIXED_SECRET,
        FIXED_MSG_ID,
        new Date(now * 1000),
        FIXED_PAYLOAD,
      );

      const result = verifyWebhookSignature(
        Buffer.from(FIXED_PAYLOAD),
        {
          "webhook-id": FIXED_MSG_ID,
          "webhook-timestamp": String(now),
          "webhook-signature": signature,
        },
        [FIXED_SECRET],
        60 * 60 * 1000, // 1 hour tolerance for this test
      );

      expect(result.valid).toBe(true);
    });
  });

  describe("Missing headers", () => {
    it("rejects missing webhook-id", () => {
      const result = verifyWebhookSignature(
        Buffer.from(FIXED_PAYLOAD),
        {
          "webhook-timestamp": "1234567890",
          "webhook-signature": "v1,sig",
        },
        [FIXED_SECRET],
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing required headers");
    });

    it("rejects missing webhook-timestamp", () => {
      const result = verifyWebhookSignature(
        Buffer.from(FIXED_PAYLOAD),
        {
          "webhook-id": FIXED_MSG_ID,
          "webhook-signature": "v1,sig",
        },
        [FIXED_SECRET],
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing required headers");
    });

    it("rejects missing webhook-signature", () => {
      const result = verifyWebhookSignature(
        Buffer.from(FIXED_PAYLOAD),
        {
          "webhook-id": FIXED_MSG_ID,
          "webhook-timestamp": "1234567890",
        },
        [FIXED_SECRET],
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing required headers");
    });
  });

  describe("Rotation window", () => {
    it("accepts valid signature with any of multiple secrets", () => {
      const secret1 = "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
      const secret2 = "whsec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=";
      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);

      const signature = independentSign(
        secret1,
        FIXED_MSG_ID,
        new Date(now),
        FIXED_PAYLOAD,
      );

      // Verify with both secrets - should succeed because secret1 matches
      const result = verifyWebhookSignature(
        Buffer.from(FIXED_PAYLOAD),
        {
          "webhook-id": FIXED_MSG_ID,
          "webhook-timestamp": String(nowSeconds),
          "webhook-signature": signature,
        },
        [secret2, secret1],
        5 * 60 * 1000, // 5 min tolerance — timestamp is "now"
      );

      expect(result.valid).toBe(true);
    });
  });

  describe("computeBodyHash", () => {
    it("produces consistent SHA-256 hex hash", () => {
      const hash1 = computeBodyHash(Buffer.from("hello"));
      const hash2 = computeBodyHash(Buffer.from("hello"));
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces different hash for different bytes", () => {
      const hash1 = computeBodyHash(Buffer.from("hello"));
      const hash2 = computeBodyHash(Buffer.from("world"));
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("constantTimeCompare", () => {
    it("returns true for equal strings", () => {
      expect(constantTimeCompare("abc", "abc")).toBe(true);
    });

    it("returns false for different strings", () => {
      expect(constantTimeCompare("abc", "abd")).toBe(false);
    });

    it("returns false for different length strings", () => {
      expect(constantTimeCompare("abc", "abcd")).toBe(false);
    });
  });

  describe("generateWebhookSecret", () => {
    it("generates secret with whsec_ prefix", () => {
      const { secret, prefixSecret } = generateWebhookSecret();
      expect(prefixSecret).toBe(`whsec_${secret}`);
      expect(prefixSecret).toMatch(/^whsec_[A-Za-z0-9+/=]+$/);
    });

    it("generates unique secrets", () => {
      const s1 = generateWebhookSecret();
      const s2 = generateWebhookSecret();
      expect(s1.prefixSecret).not.toBe(s2.prefixSecret);
    });
  });

  describe("signWebhook helper", () => {
    it("produces verifiable signature", () => {
      const now = new Date();
      const signature = signWebhook(
        FIXED_SECRET,
        FIXED_MSG_ID,
        now,
        FIXED_PAYLOAD,
      );

      const result = verifyWebhookSignature(
        Buffer.from(FIXED_PAYLOAD),
        {
          "webhook-id": FIXED_MSG_ID,
          "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
          "webhook-signature": signature.signature,
        },
        [FIXED_SECRET],
        5 * 60 * 1000,
      );

      expect(result.valid).toBe(true);
    });
  });
});
