import { z } from "zod"

// Every setting the app reads, validated once. The process refuses to start on a
// missing, malformed or obviously unsafe value, and the error names the variable,
// never its value. All problems are listed together, so one restart fixes them all.
// Parsed lazily (not at import) so `next build` needs no secrets.

const TRUE = new Set(["true", "1", "yes", "on"])
const FALSE = new Set(["false", "0", "no", "off"])

const flag = z
  .string()
  .optional()
  .transform((value, ctx): boolean | undefined => {
    const v = value?.trim().toLowerCase()
    if (v === undefined || v === "") return undefined
    if (TRUE.has(v)) return true
    if (FALSE.has(v)) return false
    ctx.addIssue({ code: "custom", message: "must be true or false" })
    return z.NEVER
  })

const required = z.string({ error: "is required" })

/** 32 random bytes as base64 or base64url. */
function decodeKey(value: string): Buffer | null {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/")
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null
  const bytes = Buffer.from(normalized, "base64")
  return bytes.length === 32 ? bytes : null
}

const looksLikePlaceholder = (value: string) => /^(change[-_ ]?me|replace[-_ ]?me|your[-_ ])/i.test(value.trim())
const WEAK_PASSWORDS = new Set(["password", "passw0rd", "admin", "administrator", "123456789012", "qwertyuiop12"])
const HASH_SHAPE = /^scrypt:\d+:\d+:\d+:[\w-]+:[\w-]+$/

// The shape of each variable on its own.
const shape = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: required
    .min(1, "is required")
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL"),
  DASHBOARD_USER: required.trim().min(3, "needs at least 3 characters").max(64, "is too long"),
  DASHBOARD_PASSWORD: z.string().optional(),
  DASHBOARD_PASSWORD_HASH: z.string().trim().optional(),
  SESSION_SECRET: required.min(32, "needs at least 32 characters"),
  ENCRYPTION_KEY: required.min(1, "is required"),
  COOKIE_SECURE: flag,
  TRUST_PROXY: flag,
  PROXY_HOPS: z.coerce.number().int().min(1).max(5).default(1),
  DEMO_MODE: flag,
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
})

/** Rules that look at more than one variable, or at what a value means. They run even when other variables are missing. */
function crossChecks(source: Record<string, string | undefined>): string[] {
  const out: string[] = []
  const password = source.DASHBOARD_PASSWORD || undefined
  const hash = source.DASHBOARD_PASSWORD_HASH?.trim() || undefined

  if (password && hash) {
    out.push("DASHBOARD_PASSWORD_HASH: set DASHBOARD_PASSWORD or DASHBOARD_PASSWORD_HASH, not both")
  } else if (!password && !hash) {
    out.push("DASHBOARD_PASSWORD_HASH: set DASHBOARD_PASSWORD_HASH (preferred) or DASHBOARD_PASSWORD")
  }
  if (hash && !HASH_SHAPE.test(hash)) {
    out.push("DASHBOARD_PASSWORD_HASH: is not a hash made by `cli hash-password`")
  }
  if (password) {
    if (password.length < 12) out.push("DASHBOARD_PASSWORD: needs at least 12 characters")
    else if (looksLikePlaceholder(password) || WEAK_PASSWORDS.has(password.toLowerCase())) {
      out.push("DASHBOARD_PASSWORD: is a placeholder or a very common password")
    }
  }

  const secret = source.SESSION_SECRET
  if (secret !== undefined && secret.length >= 32 && (looksLikePlaceholder(secret) || new Set(secret).size < 10)) {
    out.push("SESSION_SECRET: is a placeholder or has too little variety; generate one with `cli generate-secrets`")
  }
  const key = source.ENCRYPTION_KEY
  if (key !== undefined && key.length > 0 && !decodeKey(key)) {
    out.push("ENCRYPTION_KEY: must be 32 random bytes, base64 encoded; generate one with `cli generate-secrets`")
  }
  return out
}

export type Env = {
  nodeEnv: "development" | "test" | "production"
  isProduction: boolean
  databaseUrl: string
  user: string
  password: { kind: "hash"; hash: string } | { kind: "plain"; value: string }
  sessionSecret: string
  encryptionKey: Buffer
  cookieSecure: boolean
  trustProxy: boolean
  /** How many reverse proxies sit in front of the app; see lib/auth/client-ip.ts. */
  proxyHops: number
  syncIntervalMinutes: number
  demoMode: boolean
}

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`)
    this.name = "EnvError"
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = shape.safeParse(source)
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`)),
    ...crossChecks(source),
  ]
  if (!parsed.success || problems.length > 0) throw new EnvError(problems)

  const e = parsed.data
  const isProduction = e.NODE_ENV === "production"
  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    databaseUrl: e.DATABASE_URL,
    user: e.DASHBOARD_USER,
    password: e.DASHBOARD_PASSWORD_HASH
      ? { kind: "hash", hash: e.DASHBOARD_PASSWORD_HASH }
      : { kind: "plain", value: e.DASHBOARD_PASSWORD! },
    sessionSecret: e.SESSION_SECRET,
    encryptionKey: decodeKey(e.ENCRYPTION_KEY)!,
    // Secure cookies need https. Off by default only outside production.
    cookieSecure: e.COOKIE_SECURE ?? isProduction,
    // X-Forwarded-For can be trusted only when a proxy writes it, so it is ignored unless set.
    // compose.yaml turns it on: there the app can only be reached through the proxy.
    trustProxy: e.TRUST_PROXY ?? false,
    proxyHops: e.PROXY_HOPS,
    syncIntervalMinutes: e.SYNC_INTERVAL_MINUTES,
    demoMode: e.DEMO_MODE ?? false,
  }
}

let cached: Env | undefined

export function getEnv(): Env {
  return (cached ??= parseEnv(process.env))
}

export function resetEnvCache(): void {
  cached = undefined
}
