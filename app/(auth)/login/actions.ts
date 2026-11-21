"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { clearSessionCookie, readSessionToken, setSessionCookie } from "@/lib/auth/cookies"
import { checkCredentials } from "@/lib/auth/credentials"
import { clientIp } from "@/lib/auth/client-ip"
import { checkLoginAllowed, loginKeys, recordLoginAttempt, reserveLoginAttempt } from "@/lib/auth/rate-limit"
import { describeWait, safeNext } from "@/lib/auth/redirect"
import { createSession, destroySession } from "@/lib/auth/sessions"
import { getDb } from "@/lib/db/client"
import { getEnv } from "@/lib/env"

export type LoginState = { error?: string }

const input = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
  next: z.string().max(2048).optional(),
})

export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = input.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  })
  if (!parsed.success) return { error: "Enter your username and password." }
  const { username, password } = parsed.data

  const env = getEnv()
  const db = getDb()
  const requestHeaders = await headers()
  const ip = clientIp(requestHeaders, env.trustProxy, env.proxyHops)
  const keys = loginKeys(ip, username)

  const gate = await checkLoginAllowed(db, keys)
  if (!gate.allowed) return { error: `Too many attempts. Try again in ${describeWait(gate.retryAfterSeconds)}.` }

  // Counted as a failure before the slow password check, so guesses sent at once count against each other.
  const reserved = await reserveLoginAttempt(db, keys)
  if (!reserved.allowed) return { error: `Too many attempts. Try again in ${describeWait(reserved.retryAfterSeconds)}.` }

  const ok = await checkCredentials(username, password)
  // One message for a wrong username and a wrong password.
  if (!ok) return { error: "Wrong username or password." }
  await recordLoginAttempt(db, keys, true)

  const { token, expiresAt } = await createSession(db, env.sessionSecret, {
    ip,
    userAgent: requestHeaders.get("user-agent"),
  })
  await setSessionCookie(token, expiresAt)
  redirect(safeNext(parsed.data.next))
}

export async function logout(): Promise<void> {
  const token = await readSessionToken()
  if (token) await destroySession(getDb(), getEnv().sessionSecret, token)
  await clearSessionCookie()
  redirect("/login")
}
