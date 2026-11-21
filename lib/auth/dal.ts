import "server-only"
import { cache } from "react"
import { redirect } from "next/navigation"
import { getDb } from "@/lib/db/client"
import { getEnv } from "@/lib/env"
import { readSessionToken } from "./cookies"
import { findSession } from "./sessions"

// The data access layer. Next.js's proxy only checks that a cookie exists, which is
// a convenience, not a gate. Anything that reads data or changes it calls
// requireSession() itself: every page layout, every Server Action, every route handler.

/** The current session, checked against the database once per request. */
export const getSession = cache(async () => {
  const token = await readSessionToken()
  if (!token) return null
  return findSession(getDb(), getEnv().sessionSecret, token)
})

export async function requireSession(): Promise<{ id: string }> {
  const session = await getSession()
  if (!session) redirect("/login")
  return session
}

/** For route handlers, which answer 401 instead of redirecting. */
export async function hasSession(): Promise<boolean> {
  return (await getSession()) !== null
}
