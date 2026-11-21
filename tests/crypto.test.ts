import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { decryptSecret, encryptSecret, hmacHex, randomToken, safeEqual, sha256Hex } from "@/lib/crypto"

const key = randomBytes(32)

describe("encryptSecret / decryptSecret", () => {
  it("round-trips, including unicode", () => {
    for (const text of ["shptka_abc123", "", "naïve ✓ token"]) {
      expect(decryptSecret(encryptSecret(text, key), key)).toBe(text)
    }
  })

  it("uses a new IV every time, so equal inputs give different outputs", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key))
  })

  it("does not contain the plaintext", () => {
    expect(encryptSecret("shptka_abc123", key)).not.toContain("shptka_abc123")
  })

  it("has the documented shape", () => {
    expect(encryptSecret("x", key)).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]*$/)
  })

  it("rejects a tampered ciphertext", () => {
    const [v, iv, tag, ct] = encryptSecret("shptka_abc123", key).split(".")
    const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1)
    expect(() => decryptSecret([v, iv, tag, flipped].join("."), key)).toThrow()
  })

  it("rejects a tampered tag, a wrong key and malformed input", () => {
    const [v, iv, tag, ct] = encryptSecret("shptka_abc123", key).split(".")
    const badTag = (tag[0] === "A" ? "B" : "A") + tag.slice(1)
    expect(() => decryptSecret([v, iv, badTag, ct].join("."), key)).toThrow()
    expect(() => decryptSecret(encryptSecret("x", key), randomBytes(32))).toThrow()
    expect(() => decryptSecret("not a secret", key)).toThrow()
    expect(() => decryptSecret("v2.a.b.c", key)).toThrow()
    expect(() => decryptSecret("v1.a.b.c.d", key)).toThrow()
  })
})

describe("randomToken", () => {
  it("is 256 bits of url-safe text, and unique", () => {
    const a = randomToken()
    expect(a).toMatch(/^[\w-]{43}$/)
    expect(randomToken()).not.toBe(a)
  })
})

describe("hmacHex / sha256Hex", () => {
  it("is stable, keyed, and hex", () => {
    expect(hmacHex("k", "v")).toBe(hmacHex("k", "v"))
    expect(hmacHex("k", "v")).not.toBe(hmacHex("k2", "v"))
    expect(hmacHex("k", "v")).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
})

describe("safeEqual", () => {
  it("compares strings of any length", () => {
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
    expect(safeEqual("", "")).toBe(true)
  })
})
