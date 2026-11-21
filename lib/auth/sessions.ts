import { and, eq, gt, lt, lte, or } from "drizzle-orm"
import { hmacHex, randomToken } from "@/lib/crypto"
import type { Db } from "@/lib/db/client"
import { sessions } from "@/lib/db/schema"

// Sessions are rows. The cookie carries a random 256-bit token; the table stores
// only its HMAC, so a copy of the database cannot be used to log in. A session ends
// after a day of inactivity or a week in total, and can be revoked at any moment by
// deleting its row, which a signed-token (JWT) design cannot do.

export const IDLE_TIMEOUT_MS = 24 * 3_600_000
export const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 3_600_000
const TOUCH_AFTER_MS = 5 * 60_000
const TOKEN_SHAPE = /^[\w-]{43}$/

export async function createSession(
  db: Db,
  secret: string,
  meta: { ip?: string | null; userAgent?: string | null },
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken()
  const expiresAt = new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS)
  await db.insert(sessions).values({
    tokenHash: hmacHex(secret, token),
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  })
  return { token, expiresAt }
}

/** The session for this token, or null if it is unknown, idle too long, or past its end. */
export async function findSession(
  db: Db,
  secret: string,
  token: string,
  now: Date = new Date(),
): Promise<{ id: string } | null> {
  if (!TOKEN_SHAPE.test(token)) return null
  const [row] = await db
    .select({ id: sessions.id, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.tokenHash, hmacHex(secret, token)))
    .limit(1)
  if (!row) return null

  const idle = now.getTime() - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS
  if (idle || row.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, row.id))
    return null
  }
  // Written at most every few minutes, not on every request.
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.id))
  }
  return { id: row.id }
}

export async function destroySession(db: Db, secret: string, token: string): Promise<void> {
  if (!TOKEN_SHAPE.test(token)) return
  await db.delete(sessions).where(eq(sessions.tokenHash, hmacHex(secret, token)))
}

export async function destroyAllSessions(db: Db): Promise<number> {
  const removed = await db.delete(sessions).returning({ id: sessions.id })
  return removed.length
}

export async function purgeExpiredSessions(db: Db, now: Date = new Date()): Promise<void> {
  await db
    .delete(sessions)
    .where(or(lte(sessions.expiresAt, now), lt(sessions.lastSeenAt, new Date(now.getTime() - IDLE_TIMEOUT_MS))))
}

export async function countActiveSessions(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(gt(sessions.expiresAt, now), gt(sessions.lastSeenAt, new Date(now.getTime() - IDLE_TIMEOUT_MS))))
  return rows.length
}
