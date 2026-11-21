import { describe, expect, it } from "vitest"
import { hashPassword, verifyPassword } from "@/lib/auth/password"

// A low cost keeps the suite fast; the default cost is checked once below.
const cheap = { N: 2 ** 12, r: 8, p: 1 }

describe("hashPassword / verifyPassword", () => {
  it("accepts the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple", cheap)
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true)
    expect(await verifyPassword("correct horse battery stapl", hash)).toBe(false)
    expect(await verifyPassword("", hash)).toBe(false)
  })

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same", cheap), hashPassword("same", cheap)])
    expect(a).not.toBe(b)
  })

  it("stores the cost inside the hash, so old hashes keep working", async () => {
    const hash = await hashPassword("pw-with-lower-cost", { N: 2 ** 13, r: 8, p: 1 })
    expect(hash.startsWith("scrypt:8192:8:1:")).toBe(true)
    expect(await verifyPassword("pw-with-lower-cost", hash)).toBe(true)
  })

  it("treats unicode that looks the same as the same", async () => {
    const hash = await hashPassword("café-password!", cheap) // é as one character
    expect(await verifyPassword("café-password!", hash)).toBe(true) // e + combining accent
  })

  it("never throws on a hash it cannot read", async () => {
    for (const bad of ["", "plaintext", "scrypt:x:y:z:a:b", "scrypt:4096:8:1:only-salt", "bcrypt:10:a:b:c:d"]) {
      expect(await verifyPassword("pw", bad)).toBe(false)
    }
  })

  it("refuses out-of-range cost parameters without computing them", async () => {
    const tooBig = `scrypt:${2 ** 30}:8:1:c2FsdA:aGFzaA`
    const notPowerOfTwo = "scrypt:5000:8:1:c2FsdA:aGFzaA"
    const start = Date.now()
    expect(await verifyPassword("pw", tooBig)).toBe(false)
    expect(await verifyPassword("pw", notPowerOfTwo)).toBe(false)
    expect(Date.now() - start).toBeLessThan(500)
  })

  it("refuses an absurdly long password", async () => {
    const hash = await hashPassword("pw", cheap)
    expect(await verifyPassword("x".repeat(5000), hash)).toBe(false)
  })

  it("defaults to the OWASP-level cost", async () => {
    const hash = await hashPassword("default cost")
    expect(hash.startsWith("scrypt:65536:8:1:")).toBe(true)
    expect(await verifyPassword("default cost", hash)).toBe(true)
  })
})
