import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checkEnvCommand } from "../cli/commands/check-env"
import { resetEnvCache } from "@/lib/env"

const VALID = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://appmetrics:secret-db-password@db:5432/appmetrics",
  DASHBOARD_USER: "owner",
  DASHBOARD_PASSWORD: "a-long-enough-password-123",
  // Real random values: the validator refuses a secret with too little variety, which is the point.
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
}

describe("check-env", () => {
  let out: string[]
  beforeEach(() => {
    resetEnvCache()
    out = []
    vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)))
    vi.spyOn(console, "error").mockImplementation((m) => void out.push(String(m)))
    for (const key of Object.keys(VALID)) vi.stubEnv(key, VALID[key as keyof typeof VALID])
    vi.stubEnv("DASHBOARD_PASSWORD_HASH", "")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    resetEnvCache()
  })

  it("passes a good configuration and says nothing secret", () => {
    expect(checkEnvCommand()).toBe(0)
    const text = out.join("\n")
    expect(text).toContain("Configuration is valid")
    for (const secret of [VALID.DASHBOARD_PASSWORD, VALID.SESSION_SECRET, VALID.ENCRYPTION_KEY, "secret-db-password"]) expect(text).not.toContain(secret)
  })

  it("lists what is missing, in plain words, and still prints no secret", () => {
    vi.stubEnv("SESSION_SECRET", "too-short")
    vi.stubEnv("ENCRYPTION_KEY", "")
    expect(checkEnvCommand()).toBe(1)
    const text = out.join("\n")
    expect(text).toContain("SESSION_SECRET")
    expect(text).toContain("ENCRYPTION_KEY")
    expect(text).not.toContain("too-short")
    expect(text).not.toContain(VALID.DASHBOARD_PASSWORD)
  })
})
