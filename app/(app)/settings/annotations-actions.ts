"use server"

import { eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { annotationInput } from "@/lib/analytics/annotations"
import { readTimeZone } from "@/lib/analytics/queries"
import { formatDate } from "@/lib/analytics/range"
import { requireSession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db/client"
import { annotations, apps } from "@/lib/db/schema"
import { todayIn } from "@/lib/time-zone"
import type { ActionState } from "./actions"

// Annotations, from Settings. Like every action these start with requireSession(), because a
// Server Action is a public POST endpoint, and check their input before using it. An annotation
// changes no number, so nothing is rebuilt.

/** A foreign key violation: the app was removed between the check and the insert. */
function appWasRemoved(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null
  return (e?.cause?.code ?? e?.code) === "23503"
}

export async function addAnnotation(_previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession()

  const db = getDb()
  const known = await db.select({ id: apps.id }).from(apps)
  const parsed = annotationInput(known.map((a) => a.id), todayIn(await readTimeZone(db))).safeParse({
    date: formData.get("date"),
    appId: formData.get("appId"),
    label: formData.get("label"),
    note: formData.get("note"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." }
  const input = parsed.data

  try {
    await db.insert(annotations).values(input)
  } catch (err) {
    if (appWasRemoved(err)) return { error: "That app was just removed. Pick another." }
    throw err
  }

  revalidatePath("/", "layout")
  return { ok: `Marked ${formatDate(input.date)}.` }
}

export async function deleteAnnotation(annotationId: string): Promise<ActionState> {
  await requireSession()
  if (!z.uuid().safeParse(annotationId).success) return { error: "Unknown annotation." }

  const removed = await getDb().delete(annotations).where(eq(annotations.id, annotationId)).returning({ id: annotations.id })
  if (removed.length === 0) return { error: "That annotation was already deleted." }
  revalidatePath("/", "layout")
  return { ok: "Deleted." }
}
