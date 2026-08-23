import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;

let _masterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (!_masterKey) {
    const key = process.env.LEADOPS_ENCRYPTION_KEY;
    if (!key) {
      throw new Error("LEADOPS_ENCRYPTION_KEY environment variable is required");
    }
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error("LEADOPS_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
    }
    _masterKey = Buffer.from(key, "hex");
    if (_masterKey.length !== KEY_LENGTH) {
      throw new Error("LEADOPS_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
  }
  return _masterKey;
}

export function encryptSecret(plaintext: string): string {
  const masterKey = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = scryptSync(masterKey, salt, KEY_LENGTH);
  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([salt, iv, authTag, encrypted]);
  return combined.toString("base64");
}

export function decryptSecret(encryptedBase64: string): string {
  const masterKey = getMasterKey();
  const combined = Buffer.from(encryptedBase64, "base64");

  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const derivedKey = scryptSync(masterKey, salt, KEY_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
