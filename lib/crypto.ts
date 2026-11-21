import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

// Small, boring primitives. AES-256-GCM for secrets at rest (the Partner API
// tokens), HMAC for session token lookup, constant-time comparison.

const VERSION = "v1"
const IV_BYTES = 12

/** `v1.<iv>.<tag>.<ciphertext>`, each part base64url. A fresh random IV every time. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv, tag, ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".")
}

/** Throws if the value was tampered with, or was encrypted with a different key. */
export function decryptSecret(payload: string, key: Buffer): string {
  const [version, iv, tag, ciphertext, ...rest] = payload.split(".")
  // An empty ciphertext is valid: it is what an empty string encrypts to.
  if (version !== VERSION || !iv || !tag || ciphertext === undefined || rest.length > 0) {
    throw new Error("Unrecognized secret format")
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8")
}

/** 256 bits by default, URL safe. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

export function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex")
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Compares without leaking, through timing, where the first difference is or how long either side is. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest())
}
