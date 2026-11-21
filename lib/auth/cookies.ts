import { cookies } from "next/headers"
import { getEnv } from "@/lib/env"

// The session cookie is httpOnly (scripts cannot read it) and SameSite=Lax (a form on
// another site cannot make the browser send it with a POST; Server Actions also
// check the Origin header). Over https it uses the __Host- prefix, which makes the
// browser refuse a cookie set by a sibling subdomain or one that is not Secure.

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-am_session" : "am_session"
}

export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies()
  return jar.get(sessionCookieName(getEnv().cookieSecure))?.value ?? null
}

export async function setSessionCookie(token: string, expires: Date): Promise<void> {
  const { cookieSecure } = getEnv()
  const jar = await cookies()
  jar.set(sessionCookieName(cookieSecure), token, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: "lax",
    path: "/",
    expires,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const { cookieSecure } = getEnv()
  const jar = await cookies()
  jar.set(sessionCookieName(cookieSecure), "", { httpOnly: true, secure: cookieSecure, sameSite: "lax", path: "/", maxAge: 0 })
}
