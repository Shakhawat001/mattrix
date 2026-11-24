import { describe, expect, it } from "vitest"
import { generateApiToken, hashApiToken, isApiTokenShape } from "@/lib/auth/api-tokens"
import { hmacHex, randomToken } from "@/lib/crypto"

const SECRET = "a-session-secret-that-is-long-enough-123456"

describe("API token format", () => {
  it("is amt_ and 256 random bits of url-safe text, different every time", () => {
    const token = generateApiToken()
    expect(token).toMatch(/^amt_[\w-]{43}$/)
    expect(Buffer.from(token.slice(4), "base64url")).toHaveLength(32)
    expect(generateApiToken()).not.toBe(token)
  })

  it("recognizes the shape, so garbage never reaches the database", () => {
    const token = generateApiToken()
    expect(isApiTokenShape(token)).toBe(true)
    for (const bad of [
      "",
      "amt_",
      token.slice(0, -1),
      `${token}x`,
      token.replace("amt_", "AMT_"),
      token.replace("amt_", "shpat_"),
      randomToken(), // a session token: right length, no prefix
      `amt_${"a".repeat(42)}=`,
      `amt_${"a".repeat(42)}+`,
      `amt_${"a".repeat(42)}/`,
      `amt_${"a".repeat(42)} `,
      `${token}\n`,
      ` ${token}`,
    ]) {
      expect(isApiTokenShape(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe("API token hashing", () => {
  it("is an HMAC-SHA256 keyed with the session secret, the way sessions are stored", () => {
    const token = generateApiToken()
    expect(hashApiToken(SECRET, token)).toBe(hmacHex(SECRET, token))
    expect(hashApiToken(SECRET, token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashApiToken(SECRET, token)).toBe(hashApiToken(SECRET, token))
  })

  it("depends on the secret and on the token, and gives neither away", () => {
    const token = generateApiToken()
    expect(hashApiToken("another-secret-that-is-also-long-enough-9876", token)).not.toBe(hashApiToken(SECRET, token))
    expect(hashApiToken(SECRET, generateApiToken())).not.toBe(hashApiToken(SECRET, token))
    expect(hashApiToken(SECRET, token)).not.toContain(token.slice(4))
  })
})
