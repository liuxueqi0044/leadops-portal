import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** Minimum token length in bytes (32 bytes = 256 bits). */
const TOKEN_BYTES = 32;

/** Token purpose constants. */
export const TOKEN_PURPOSES = {
  PUBLIC_DECISION: "public_decision",
} as const;

export type TokenPurpose = (typeof TOKEN_PURPOSES)[keyof typeof TOKEN_PURPOSES];

/** Result of generating a new one-time token. */
export interface TokenPair {
  /** The plaintext token to include in URLs (never stored). */
  plaintext: string;
  /** The SHA-256 hash to store in the database. */
  hash: string;
}

/**
 * Generate a cryptographically secure random token and its SHA-256 hash.
 * The plaintext is returned as base64url for URL safety.
 * Only the hash is stored in the database.
 */
export function generateApprovalToken(): TokenPair {
  const bytes = randomBytes(TOKEN_BYTES);
  const plaintext = bytes.toString("base64url");
  const hash = sha256(plaintext);
  return { plaintext, hash };
}

/**
 * Hash a token for database comparison. Uses SHA-256.
 */
export function hashToken(plaintext: string): string {
  return sha256(plaintext);
}

/**
 * Constant-time string comparison for token verification.
 */
export function constantTimeCompareToken(
  a: string,
  b: string,
): boolean {
  if (a.length !== b.length) return false;
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && safeCompare(bufA, bufB);
  } catch {
    return false;
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function safeCompare(a: Buffer, b: Buffer): boolean {
  try {
    return timingSafeEqual(a, b);
  } catch {
    let result = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      result |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return result === 0;
  }
}

/** Sanitize a token for logging: show only first 4 and last 4 chars. */
export function redactToken(plaintext: string): string {
  if (plaintext.length <= 8) return "****";
  return `${plaintext.slice(0, 4)}...${plaintext.slice(-4)}`;
}
