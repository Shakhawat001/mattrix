"use server"

import { eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { readTimeZone } from "@/lib/analytics/queries"
import { isDate } from "@/lib/analytics/range"
import { clearSessionCookie } from "@/lib/auth/cookies"
import { requireSession } from "@/lib/auth/dal"
import { destroyAllSessions } from "@/lib/auth/sessions"
import { getDb } from "@/lib/db/client"
import { apps, connections, settings } from "@/lib/db/schema"
import { encryptToken } from "@/lib/secrets"
import { normalizeTimeZone, todayIn } from "@/lib/time-zone"

// Every action starts with requireSession(): a Server Action is a public POST endpoint, so
// being behind the login page protects nothing by itself. Input is validated before use, and
// no message ever contains the token. This process never calls Shopify; it only records what
// to do and the worker does it.

export type ActionState = { ok?: string; error?: string }

const MAX_CONNECTIONS = 20
const APP_GID = /^gid:\/\/shopify\/App\/\d+$/

/** `today` is today in the dashboard's time zone, the latest day the date picker offered. */
const connectionInput = (today: string) => z.object({
  label: z.string().trim().min(1, "Give the connection a name.").max(60, "Keep the name under 60 characters."),
  partnerId: z.string().trim().regex(/^\d{1,20}$/, "The Partner ID is a number. You can find it in the address of your Partner Dashboard."),
  token: z
    .string()
    .trim()
    .min(16, "That token looks too short.")
    .max(2048, "That token looks too long.")
    .regex(/^[\w.~+/=-]+$/, "A token has no spaces or other special characters."),
  backfillFrom: z.string().refine((d) => isDate(d) && d >= "2012-01-01" && d <= today, "Pick a real date between 2012 and today to read history from."),
  apiVersion: z.string().trim().regex(/^(\d{4}-\d{2}|unstable)$/, "An API version looks like 2026-07."),
  appGids: z.string().trim().max(4000).optional(),
})

const id = z.uuid("Unknown item.")

function fail(error: string): ActionState {
  return { error }
}

export async function addConnection(_previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession()

  const db = getDb()
  const parsed = connectionInput(todayIn(await readTimeZone(db))).safeParse({
    label: formData.get("label"),
    partnerId: formData.get("partnerId"),
    token: formData.get("token"),
    backfillFrom: formData.get("backfillFrom"),
    apiVersion: formData.get("apiVersion") || "2026-07",
    appGids: formData.get("appGids") || undefined,
  })
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form and try again.")
  const input = parsed.data

  const appGids = (input.appGids ?? "").split(/[\s,]+/).filter(Boolean)
  if (appGids.some((g) => !APP_GID.test(g))) return fail("App IDs look like gid://shopify/App/123. Leave the box empty to read every app.")

  const existing = await db.select({ partnerId: connections.partnerId }).from(connections)
  if (existing.length >= MAX_CONNECTIONS) return fail(`That is the limit of ${MAX_CONNECTIONS} connections.`)
  if (existing.some((c) => c.partnerId === input.partnerId)) return fail("That Partner ID is already connected. One token covers every app in the organization.")

  const { ciphertext, hint } = encryptToken(input.token)
  await db.insert(connections).values({
    label: input.label,
    partnerId: input.partnerId,
    tokenCiphertext: ciphertext,
    tokenHint: hint,
    apiVersion: input.apiVersion,
    appGids,
    // A date, kept as midnight UTC of it and shown as that date again. History starts at most a
    // few hours from the zone's own midnight, which matters nothing for a backfill.
    backfillFrom: new Date(`${input.backfillFrom}T00:00:00Z`),
    // The worker picks this up within a minute. A wrong token shows up as an error on the connection.
    syncRequestedAt: new Date(),
  })

  revalidatePath("/", "layout")
  return { ok: "Connection added. The first sync starts within a minute and can take a few minutes. Its result shows up on the connection." }
}

export async function requestSync(connectionId: string): Promise<ActionState> {
  await requireSession()
  if (!id.safeParse(connectionId).success) return fail("Unknown connection.")

  const db = getDb()
  const [row] = await db.select({ paused: connections.paused, isDemo: connections.isDemo }).from(connections).where(eq(connections.id, connectionId))
  if (!row) return fail("Unknown connection.")
  if (row.isDemo) return fail("Demo data is never synced.")
  if (row.paused) return fail("It is paused. Resume it first.")

  await db.update(connections).set({ syncRequestedAt: new Date() }).where(eq(connections.id, connectionId))
  revalidatePath("/settings")
  return { ok: "Sync requested. It starts within a minute." }
}

export async function setPaused(connectionId: string, paused: boolean): Promise<ActionState> {
  await requireSession()
  if (!id.safeParse(connectionId).success) return fail("Unknown connection.")

  const updated = await getDb().update(connections).set({ paused: Boolean(paused) }).where(eq(connections.id, connectionId)).returning({ id: connections.id })
  if (updated.length === 0) return fail("Unknown connection.")
  revalidatePath("/settings")
  return { ok: paused ? "Paused. Nothing new is read until you resume." : "Resumed." }
}

export async function removeConnection(connectionId: string): Promise<ActionState> {
  await requireSession()
  if (!id.safeParse(connectionId).success) return fail("Unknown connection.")

  // Everything read through it goes with it: apps, events and the numbers built from them.
  const removed = await getDb().delete(connections).where(eq(connections.id, connectionId)).returning({ id: connections.id })
  if (removed.length === 0) return fail("Unknown connection.")
  revalidatePath("/", "layout")
  return { ok: "Removed, with its apps and their numbers." }
}

const appInput = z.object({
  appId: id,
  displayName: z.string().trim().max(60, "Keep the name under 60 characters.").optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color.").optional(),
  hidden: z.enum(["true", "false"]),
})

export async function updateApp(_previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession()

  const parsed = appInput.safeParse({
    appId: formData.get("appId"),
    displayName: formData.get("displayName") || undefined,
    color: formData.get("color") || undefined,
    hidden: formData.get("hidden") ?? "false",
  })
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form and try again.")
  const { appId, displayName, color, hidden } = parsed.data

  const updated = await getDb()
    .update(apps)
    .set({ displayName: displayName ?? null, color: color?.toLowerCase() ?? null, hidden: hidden === "true" })
    .where(eq(apps.id, appId))
    .returning({ id: apps.id })
  if (updated.length === 0) return fail("Unknown app.")

  revalidatePath("/", "layout")
  return { ok: "Saved." }
}

/**
 * Picks the time zone days are counted in and times are shown in. The daily numbers are built
 * in the old one until the worker rebuilds them on its next pass (within a minute, or after a sync
 * that is running finishes): it rebuilds every app whose
 * numbers were built in another zone, so nothing else is needed here.
 */
export async function updateTimeZone(_previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession()

  const timeZone = normalizeTimeZone(formData.get("timeZone"))
  if (!timeZone) return fail("Pick a time zone from the list.")

  const db = getDb()
  if (timeZone === (await readTimeZone(db))) return { ok: `Days already run midnight to midnight in ${timeZone}.` }
  const updatedAt = new Date()
  await db.insert(settings).values({ id: 1, timeZone, updatedAt }).onConflictDoUpdate({ target: settings.id, set: { timeZone, updatedAt } })

  revalidatePath("/", "layout")
  return { ok: `Saved. Days now run midnight to midnight in ${timeZone}, and the numbers are rebuilt that way. That usually takes under a minute, longer while a sync is running.` }
}

export async function signOutEverywhere(): Promise<void> {
  await requireSession()
  await destroyAllSessions(getDb())
  await clearSessionCookie()
  redirect("/login")
}
