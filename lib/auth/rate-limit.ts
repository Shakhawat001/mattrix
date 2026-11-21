import { and, eq, gt, lt } from "drizzle-orm"
import { sha256Hex } from "@/lib/crypto"
import type { Db } from "@/lib/db/client"
import { loginAttempts } from "@/lib/db/schema"
import { addressBucket } from "./client-ip"
import { GLOBAL_WINDOW_MS, KEY_WINDOW_MS, judgeAttempt, retryAfterSeconds, type Attempt } from "./rate-limit-core"

// Login attempts are kept in Postgres, so a restart does not give an attacker a
// fresh start. The rules themselves are in rate-limit-core.ts.

const GLOBAL_KEY = "global"
const KEEP_MS = 24 * 3_600_000

/** What the limiter keys on: the address (an IPv6 /64 counts as one), the username (hashed, since attackers choose it), and everything together. */
export function loginKeys(ip: string, username: string): string[] {
  return [`ip:${addressBucket(ip)}`, `user:${sha256Hex(username.trim().toLowerCase()).slice(0, 32)}`, GLOBAL_KEY]
}

async function attemptsFor(db: Db, key: string, sinceMs: number): Promise<Attempt[]> {
  const rows = await db
    .select({ at: loginAttempts.at, ok: loginAttempts.ok })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.key, key), gt(loginAttempts.at, new Date(sinceMs))))
  return rows.map((r) => ({ at: r.at.getTime(), ok: r.ok }))
}

export type LoginGate = { allowed: true } | { allowed: false; retryAfterSeconds: number }

async function judge(db: Db, keys: string[], now: number, includesCurrent: boolean): Promise<LoginGate> {
  const [ip, user, global] = keys
  const verdict = judgeAttempt(
    {
      ip: await attemptsFor(db, ip, now - KEY_WINDOW_MS),
      user: await attemptsFor(db, user, now - KEY_WINDOW_MS),
      global: await attemptsFor(db, global ?? GLOBAL_KEY, now - GLOBAL_WINDOW_MS),
    },
    now,
    includesCurrent,
  )
  return verdict.allowed ? { allowed: true } : { allowed: false, retryAfterSeconds: retryAfterSeconds(verdict.until, now) }
}

/** A quick look before doing any work: refuses an attempt that would be refused anyway, without writing anything. */
export function checkLoginAllowed(db: Db, keys: string[], now: number = Date.now()): Promise<LoginGate> {
  return judge(db, keys, now, false)
}

/**
 * Records the attempt as a failure before the password is checked, then decides with it
 * counted. Guesses sent at the same moment therefore count against each other instead of all
 * seeing a clean record. A correct password is recorded as a success afterwards, which makes
 * the earlier failures, this one included, stop counting.
 */
export async function reserveLoginAttempt(db: Db, keys: string[], now: number = Date.now()): Promise<LoginGate> {
  await recordLoginAttempt(db, keys, false, now)
  return judge(db, keys, now, true)
}

export async function recordLoginAttempt(db: Db, keys: string[], ok: boolean, now: number = Date.now()): Promise<void> {
  const at = new Date(now)
  await db.insert(loginAttempts).values(keys.map((key) => ({ key, at, ok })))
  await db.delete(loginAttempts).where(lt(loginAttempts.at, new Date(now - KEEP_MS)))
}
