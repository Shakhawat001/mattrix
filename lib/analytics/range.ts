// Date ranges, as calendar days written "YYYY-MM-DD", both ends included. The days are days in
// the dashboard's time zone, but nothing here needs to know which: this is arithmetic on the
// strings, with UTC used only as a calendar to count on. Turning a day into instants, or an
// instant into a day, is lib/time-zone.ts's job, and today comes from there too.
// Everything the dashboard shows is for a range like this, picked freely or from a preset.

const DAY_MS = 86_400_000
const MAX_SPAN_DAYS = 1830 // five years

export type Range = { from: string; to: string }
export type Compare = "none" | "previous" | "year"
export type Granularity = "day" | "week" | "month"

export const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`)
export const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const addDays = (date: string, days: number) => fromMs(toMs(date) + days * DAY_MS)
export const dayCount = (range: Range) => Math.round((toMs(range.to) - toMs(range.from)) / DAY_MS) + 1

/** A real calendar day. "2026-13-45" and "2026-02-30" are not, and must not throw. */
export function isDate(value: string | undefined | null): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const ms = toMs(value)
  return Number.isFinite(ms) && fromMs(ms) === value
}

export const PRESETS = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "mtd", label: "This month" },
  { key: "lastmonth", label: "Last month" },
  { key: "qtd", label: "This quarter" },
  { key: "ytd", label: "This year" },
  { key: "12m", label: "Last 12 months" },
  { key: "all", label: "All time" },
] as const

export type PresetKey = (typeof PRESETS)[number]["key"]

export function presetRange(key: string, today: string, earliest: string | null): Range | null {
  const [y, m] = today.split("-").map(Number)
  const monthStart = (year: number, month: number) => fromMs(Date.UTC(year, month - 1, 1))
  switch (key) {
    case "7d":
      return { from: addDays(today, -6), to: today }
    case "30d":
      return { from: addDays(today, -29), to: today }
    case "90d":
      return { from: addDays(today, -89), to: today }
    case "12m":
      return { from: addDays(today, -364), to: today }
    case "mtd":
      return { from: monthStart(y, m), to: today }
    case "lastmonth": {
      const first = monthStart(y, m - 1)
      return { from: first, to: addDays(monthStart(y, m), -1) }
    }
    case "qtd":
      return { from: monthStart(y, Math.floor((m - 1) / 3) * 3 + 1), to: today }
    case "ytd":
      return { from: monthStart(y, 1), to: today }
    case "all":
      return { from: earliest ?? addDays(today, -29), to: today }
    default:
      return null
  }
}

/**
 * The range a page should show. A preset wins; otherwise `from` and `to` are used
 * when both are real dates. Anything else, or anything unreasonable, falls back to the
 * last 30 days. The end is never in the future and the span is capped at five years.
 */
export function resolveRange(params: { from?: string; to?: string; preset?: string }, today: string, earliest: string | null): Range {
  const fallback = presetRange("30d", today, earliest)!
  let range = (params.preset && presetRange(params.preset, today, earliest)) || null
  if (!range && isDate(params.from) && isDate(params.to)) range = { from: params.from, to: params.to }
  if (!range) return fallback

  let { from, to } = range
  if (to > today) to = today
  if (from > to) from = to
  if (dayCount({ from, to }) > MAX_SPAN_DAYS) from = addDays(to, -(MAX_SPAN_DAYS - 1))
  return { from, to }
}

export function previousRange(range: Range): Range {
  const days = dayCount(range)
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) }
}

function yearBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const year = d.getUTCFullYear() - 1
  const month = d.getUTCMonth()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return fromMs(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay)))
}

export function yearAgoRange(range: Range): Range {
  return { from: yearBefore(range.from), to: yearBefore(range.to) }
}

export function compareRange(range: Range, compare: Compare): Range | null {
  return compare === "previous" ? previousRange(range) : compare === "year" ? yearAgoRange(range) : null
}

/** Days for a month or less, weeks for up to about nine months, months beyond that. */
export function autoGranularity(range: Range): Granularity {
  const days = dayCount(range)
  return days <= 45 ? "day" : days <= 270 ? "week" : "month"
}

/** The first day of the bucket a date belongs to: itself, its Monday, or the 1st of its month. */
export function bucketKey(date: string, granularity: Granularity): string {
  if (granularity === "day") return date
  if (granularity === "month") return `${date.slice(0, 7)}-01`
  const sinceMonday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
  return addDays(date, -sinceMonday)
}

export function nextBucket(key: string, granularity: Granularity): string {
  if (granularity === "day") return addDays(key, 1)
  if (granularity === "week") return addDays(key, 7)
  const d = new Date(`${key}T00:00:00Z`)
  return fromMs(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
}

/** Every bucket the range touches, first to last. */
export function bucketsIn(range: Range, granularity: Granularity): string[] {
  const out: string[] = []
  const last = bucketKey(range.to, granularity)
  for (let key = bucketKey(range.from, granularity); key <= last; key = nextBucket(key, granularity)) out.push(key)
  return out
}

const short = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const long = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
const monthName = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })

export function formatDate(date: string): string {
  return long.format(new Date(`${date}T00:00:00Z`))
}

export function formatRange(range: Range): string {
  return range.from === range.to ? formatDate(range.from) : `${formatDate(range.from)} to ${formatDate(range.to)}`
}

/** A short axis label for a bucket. */
export function bucketLabel(key: string, granularity: Granularity): string {
  const d = new Date(`${key}T00:00:00Z`)
  return granularity === "month" ? monthName.format(d) : short.format(d)
}
