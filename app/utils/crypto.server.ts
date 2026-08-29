import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for Shopify access tokens at rest.
 *
 * Storage format (single string in shops.access_token):
 *   <iv b64>.<authTag b64>.<ciphertext b64>
 *
 * - iv:         12 random bytes per encryption (base64). Never reused with
 *               the same key.
 * - authTag:    16-byte GCM authentication tag (base64). Required to verify
 *               and decrypt.
 * - ciphertext: the encrypted token (base64).
 *
 * The key must be a 32-byte hex string (64 hex chars) in
 * TOKEN_ENCRYPTION_KEY. It is read lazily so a missing key fails with a
 * clear error at the call site instead of crashing the whole server boot.
 */

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const SEPARATOR = ".";

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32",
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex chars (${KEY_BYTES} bytes), got ${raw.length} chars`,
    );
  }
  return key;
}

/** Encrypt a plaintext token. Returns "<iv>.<authTag>.<ciphertext>" (base64 parts). */
export function encryptToken(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(SEPARATOR);
}

/** Decrypt a value produced by encryptToken(). Throws on tampered/malformed input. */
export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(SEPARATOR);
  if (parts.length !== 3) {
    throw new Error(
      "decryptToken: value is not in the expected '<iv>.<authTag>.<ciphertext>' format",
    );
  }
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}