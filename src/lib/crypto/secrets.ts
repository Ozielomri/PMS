/**
 * X-15 field-level encryption for secrets stored in the database (webhook signing secrets now;
 * door codes and API keys later). AES-256-GCM with a random 96-bit IV.
 *
 * Format: "v1.<iv>.<tag>.<ciphertext>" (base64url parts). The key comes from PMS_ENCRYPTION_KEY
 * (32 bytes, base64). The optional `context` is bound as additional authenticated data, so a
 * ciphertext copied to another row (different context) fails to decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function parseKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("PMS_ENCRYPTION_KEY must be 32 bytes encoded as base64");
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer, context = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, key: Buffer, context = ""): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unsupported secret format");
  }
  const [, iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/** Random URL-safe token with a readable prefix, e.g. "whsec_…". */
export function generateToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}
