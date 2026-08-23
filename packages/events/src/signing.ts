import { Webhook } from "standardwebhooks";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

export { WebhookVerificationError } from "standardwebhooks";

export interface SignResult {
  headers: {
    "webhook-id": string;
    "webhook-timestamp": string;
    "webhook-signature": string;
  };
}

const TOLERANCE_MS = 5 * 60 * 1000;

export function createWebhookSigner(secret: string | Uint8Array): {
  sign: (msgId: string, timestamp: Date, payload: string | Buffer) => string;
  verify: (payload: string | Buffer, headers: Record<string, string>) => unknown;
} {
  const wh = new Webhook(secret);
  return {
    sign(msgId, timestamp, payload) {
      return wh.sign(msgId, timestamp, payload);
    },
    verify(payload, headers) {
      return wh.verify(payload, headers);
    },
  };
}

export function verifyWebhookSignature(
  payload: Buffer,
  headers: Record<string, string>,
  secrets: string[],
  toleranceMs: number = TOLERANCE_MS,
): { valid: boolean; error?: string } {
  const msgId = headers["webhook-id"];
  const msgTimestamp = headers["webhook-timestamp"];
  const msgSignature = headers["webhook-signature"];

  if (!msgId || !msgTimestamp || !msgSignature) {
    return { valid: false, error: "Missing required headers" };
  }

  if (!/^[a-zA-Z0-9\-_]{1,200}$/.test(msgId)) {
    return { valid: false, error: "Invalid webhook-id format" };
  }

  if (!/^\d{1,12}$/.test(msgTimestamp)) {
    return { valid: false, error: "Invalid webhook-timestamp" };
  }
  const timestampNum = Number(msgTimestamp);

  const now = Date.now();
  const ts = timestampNum * 1000;
  if (now - ts > toleranceMs) {
    return { valid: false, error: "Message timestamp too old" };
  }
  if (ts - now > toleranceMs) {
    return { valid: false, error: "Message timestamp too new" };
  }

  const timestampDate = new Date(ts);

  for (const secret of secrets) {
    try {
      const wh = new Webhook(secret);
      const expectedSignature = wh.sign(msgId, timestampDate, payload);

      const parts = expectedSignature.split(",");
      const expectedPart = parts[1];
      if (!expectedPart) continue;

      const passedSignatures = msgSignature.split(" ");

      for (const versionedSignature of passedSignatures) {
        const parts = versionedSignature.split(",");
        const version = parts[0];
        const signature = parts[1];
        if (version !== "v1" || !signature) {
          continue;
        }
        if (constantTimeCompare(signature, expectedPart)) {
          return { valid: true };
        }
      }
    } catch {
      continue;
    }
  }

  return { valid: false, error: "No matching signature found" };
}

export function signWebhook(
  secret: string,
  msgId: string,
  timestamp: Date,
  payload: string | Buffer,
): { signature: string } {
  const wh = new Webhook(secret);
  return { signature: wh.sign(msgId, timestamp, payload) };
}

export function generateWebhookSecret(): {
  secret: string;
  prefixSecret: string;
} {
  const raw = randomBytes(32).toString("base64");
  return {
    secret: raw,
    prefixSecret: `whsec_${raw}`,
  };
}

export function computeBodyHash(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
