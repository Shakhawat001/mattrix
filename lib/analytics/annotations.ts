import { and, asc, desc, gte, inArray, isNull, lte, or } from "drizzle-orm"
import { z } from "zod"
import type { Queryable } from "@/lib/db/client"
import { annotations } from "@/lib/db/schema"
import { formatDate, fromMs, isDate, type Range } from "./range"

// Annotations: a day marked with a short label, for one app or for every app, so the charts
// explain themselves later: a price change, a release, an App Store feature, an ad campaign.
// Days are days in the dashboard's time zone, like every other date here.

export type Annotation = {
  id: string
  /** The app it is about, or null for every app. */
  appId: string | null
  /** A day in the dashboard's time zone, YYYY-MM-DD. */
  date: string
  label: string
  note: string | null
  createdAt: Date
}

const columns = {
  id: annotations.id,
  appId: annotations.appId,
  date: annotations.date,
  label: annotations.label,
  note: annotations.note,
  createdAt: annotations.createdAt,
}

/** The annotations for these apps in a range: each app's own and the every-app ones, both ends included, oldest first. No apps reads nothing. */
export async function getAnnotations(db: Queryable, appIds: string[], range: Range): Promise<Annotation[]> {
  if (appIds.length === 0) return []
  return db
    .select(columns)
    .from(annotations)
    .where(and(or(inArray(annotations.appId, appIds), isNull(annotations.appId)), gte(annotations.date, range.from), lte(annotations.date, range.to)))
    .orderBy(asc(annotations.date), asc(annotations.createdAt), asc(annotations.id))
}

/** Every annotation, newest first, for Settings. */
export async function listAnnotations(db: Queryable): Promise<Annotation[]> {
  return db.select(columns).from(annotations).orderBy(desc(annotations.date), desc(annotations.createdAt), desc(annotations.id))
}

// ---------------------------------------------------------------------------
// What the Settings form may save
// ---------------------------------------------------------------------------

/** The form's value for "All apps". */
export const ALL_APPS = "all"
export const FIRST_ANNOTATION_DATE = "2012-01-01"

/** The latest day that can be marked: the same day next year, so a planned launch can go in ahead of time. */
export function lastAnnotationDate(today: string): string {
  const [year, month, day] = today.split("-").map(Number)
  return fromMs(Date.UTC(year + 1, month - 1, day))
}

// A control character other than a line break or a tab. Postgres refuses a NUL in text outright.
const CONTROL = /(?![\t\n])\p{Cc}/u

/**
 * The form's fields, checked: a real day from 2012 to a year from today, "all" or the id of an app
 * that exists, a label of at most 60 characters on one line, and a note of at most 500.
 */
export function annotationInput(appIds: readonly string[], today: string) {
  const last = lastAnnotationDate(today)
  return z.object({
    date: z.string("Pick a date.").refine((d) => isDate(d) && d >= FIRST_ANNOTATION_DATE && d <= last, `Pick a real date between ${formatDate(FIRST_ANNOTATION_DATE)} and ${formatDate(last)}.`),
    appId: z
      .string("Pick an app, or All apps.")
      .refine((id) => id === ALL_APPS || appIds.includes(id), "Unknown app. Reload the page and pick again.")
      .transform((id) => (id === ALL_APPS ? null : id)),
    label: z
      .string("Write a short label.")
      .transform((s) => s.replace(/\s+/g, " ").trim())
      .pipe(z.string().min(1, "Write a short label.").max(60, "Keep the label to 60 characters.").refine((s) => !CONTROL.test(s), "Use plain text in the label.")),
    note: z
      .string("Use plain text in the note.")
      .nullish()
      .transform((s) => (s ?? "").replace(/\r\n?/g, "\n").trim())
      .pipe(z.string().max(500, "Keep the note to 500 characters.").refine((s) => !CONTROL.test(s), "Use plain text in the note."))
      .transform((s) => s || null),
  })
}
