import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { EnvError, parseEnv } from "@/lib/env"

const key = randomBytes(32).toString("base64")
const hash = "scrypt:65536:8:1:c2FsdHNhbHRzYWx0c2FsdA:aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g"

const valid = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://appmetrics:pw@db:5432/appmetrics",
  DASHBOARD_USER: "owner",
  DASHBOARD_PASSWORD_HASH: hash,
  SESSION_SECRET: randomBytes(32).toString("base64url"),
  ENCRYPTION_KEY: key,
}

function problems(env: Record<string, string | undefined>): string[] {
  try {
    parseEnv(env)
    return []
  } catch (err) {
    if (err instanceof EnvError) return err.problems
    throw err
  }
}

describe("parseEnv", () => {
  it("accepts a complete production setup", () => {
    const env = parseEnv(valid)
    expect(env.user).toBe("owner")
    expect(env.password).toEqual({ kind: "hash", hash })
    expect(env.encryptionKey).toHaveLength(32)
    expect(env.syncIntervalMinutes).toBe(60)
  })

  it("accepts a plain password of 12+ characters", () => {
    const env = parseEnv({ ...valid, DASHBOARD_PASSWORD_HASH: undefined, DASHBOARD_PASSWORD: "a-long-enough-pass" })
    expect(env.password).toEqual({ kind: "plain", value: "a-long-enough-pass" })
  })

  it("accepts a base64url encryption key", () => {
    const urlSafe = randomBytes(32).toString("base64url")
    expect(() => parseEnv({ ...valid, ENCRYPTION_KEY: urlSafe })).not.toThrow()
  })

  it("names each missing variable", () => {
    const list = problems({})
    for (const name of ["DATABASE_URL", "DASHBOARD_USER", "SESSION_SECRET", "ENCRYPTION_KEY", "DASHBOARD_PASSWORD_HASH"]) {
      expect(list.some((p) => p.startsWith(name))).toBe(true)
    }
  })

  it("requires exactly one of password and hash", () => {
    expect(problems({ ...valid, DASHBOARD_PASSWORD: "a-long-enough-pass" }).join()).toMatch(/not both/)
    expect(problems({ ...valid, DASHBOARD_PASSWORD_HASH: undefined }).join()).toMatch(/set DASHBOARD_PASSWORD_HASH/)
  })

  it("rejects a hash that cli hash-password did not make", () => {
    expect(problems({ ...valid, DASHBOARD_PASSWORD_HASH: "hunter2" }).join()).toMatch(/not a hash/)
  })

  it("rejects short, placeholder and common plain passwords", () => {
    const plain = { ...valid, DASHBOARD_PASSWORD_HASH: undefined }
    expect(problems({ ...plain, DASHBOARD_PASSWORD: "short" }).join()).toMatch(/at least 12/)
    expect(problems({ ...plain, DASHBOARD_PASSWORD: "change-me-please" }).join()).toMatch(/placeholder/)
    expect(problems({ ...plain, DASHBOARD_PASSWORD: "123456789012" }).join()).toMatch(/common/)
  })

  it("rejects weak session secrets", () => {
    expect(problems({ ...valid, SESSION_SECRET: "short" }).join()).toMatch(/at least 32/)
    expect(problems({ ...valid, SESSION_SECRET: "a".repeat(40) }).join()).toMatch(/variety/)
    expect(problems({ ...valid, SESSION_SECRET: "change-me-change-me-change-me-change-me" }).join()).toMatch(/placeholder/)
  })

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(problems({ ...valid, ENCRYPTION_KEY: randomBytes(16).toString("base64") }).join()).toMatch(/32 random bytes/)
    expect(problems({ ...valid, ENCRYPTION_KEY: "not base64 !!" }).join()).toMatch(/32 random bytes/)
  })

  it("rejects a database URL that is not postgres", () => {
    expect(problems({ ...valid, DATABASE_URL: "mysql://x" }).join()).toMatch(/postgres/)
  })

  it("never puts a secret value in its error message", () => {
    const secret = "supersecretvalue-" + "x".repeat(10)
    try {
      parseEnv({ ...valid, DASHBOARD_PASSWORD_HASH: undefined, DASHBOARD_PASSWORD: secret.slice(0, 5), SESSION_SECRET: secret })
    } catch (err) {
      expect((err as Error).message).not.toContain(secret)
      expect((err as Error).message).not.toContain(secret.slice(0, 5))
      return
    }
    throw new Error("expected parseEnv to throw")
  })

  it("makes cookies secure in production, and lets you turn that off for local http", () => {
    expect(parseEnv(valid).cookieSecure).toBe(true)
    expect(parseEnv({ ...valid, NODE_ENV: "development" }).cookieSecure).toBe(false)
    expect(parseEnv({ ...valid, COOKIE_SECURE: "false" }).cookieSecure).toBe(false)
    expect(parseEnv({ ...valid, NODE_ENV: "development", COOKIE_SECURE: "yes" }).cookieSecure).toBe(true)
  })

  it("reads flags and the sync interval, and bounds the interval", () => {
    const env = parseEnv({ ...valid, TRUST_PROXY: "off", DEMO_MODE: "1", SYNC_INTERVAL_MINUTES: "15" })
    expect(env.trustProxy).toBe(false)
    expect(parseEnv(valid).trustProxy).toBe(false)
    expect(parseEnv({ ...valid, TRUST_PROXY: "true" }).trustProxy).toBe(true)
    expect(env.demoMode).toBe(true)
    expect(env.syncIntervalMinutes).toBe(15)
    expect(problems({ ...valid, SYNC_INTERVAL_MINUTES: "1" })).not.toHaveLength(0)
    expect(problems({ ...valid, TRUST_PROXY: "maybe" }).join()).toMatch(/true or false/)
  })
})
