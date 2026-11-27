import type { MetricDef, MetricFormat } from "@/lib/analytics/metrics-registry"

// How numbers are written. Amounts are in cents and in US dollars: Shopify pays partners in
// dollars whatever currency the merchant paid in.

const integer = new Intl.NumberFormat("en-US")
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

export const NONE = "n/a"

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>()

/**
 * "Nov 21, 2026, 20:03 GMT+6", or "Nov 21, 2026, 14:03 UTC": a moment on the clock of the
 * dashboard's time zone, with the zone written after it so a time is never ambiguous.
 */
export function formatDateTime(date: Date, timeZone: string): string {
  let format = dateTimeFormats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone, timeZoneName: "short" })
    dateTimeFormats.set(timeZone, format)
  }
  return format.format(date)
}

/** `-0` (a loss of nothing) prints as "-$0" otherwise. */
const clean = (n: number) => (Object.is(n, -0) ? 0 : n)

export function formatInt(n: number): string {
  return integer.format(clean(Math.round(n)))
}

/** `$1,234`, or `$12.34` for small amounts; with `compact`, `$12.4K` for large ones. */
export function formatMoney(cents: number, options: { compact?: boolean } = {}): string {
  const dollars = clean(cents) / 100
  if (options.compact && Math.abs(dollars) >= 10_000) return `${dollars < 0 ? "-" : ""}$${compactNumber.format(Math.abs(dollars))}`
  const whole = Number.isInteger(dollars) || Math.abs(dollars) >= 1000
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: whole ? 0 : 2, minimumFractionDigits: whole ? 0 : 2 }).format(dollars)
}

export function formatPercent(ratio: number, digits = 1): string {
  return `${clean(ratio * 100).toFixed(digits)}%`
}

export function formatDays(days: number): string {
  return days < 10 ? `${days.toFixed(1)} days` : `${Math.round(days)} days`
}

export function formatValue(value: number | null | undefined, format: MetricFormat, options: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NONE
  switch (format) {
    case "int":
      return formatInt(value)
    case "money":
      return formatMoney(value, options)
    case "percent":
      return formatPercent(value)
    case "days":
      return formatDays(value)
  }
}

/** A short tick for a chart axis. */
export function formatAxis(value: number, format: MetricFormat): string {
  if (format === "money") return formatMoney(value, { compact: true })
  if (format === "percent") return `${Math.round(value * 100)}%`
  if (format === "days") return `${Math.round(value)}d`
  return Math.abs(value) >= 10_000 ? compactNumber.format(value) : formatInt(value)
}

export type Change = { text: string; tone: "good" | "bad" | "flat" | "none" }

/**
 * How a number changed against its comparison, and whether that is good news. Counts and
 * amounts change by a percentage; rates change by percentage points. A change from zero
 * has no percentage, so it says so rather than inventing one.
 */
export function describeChange(current: number | null, previous: number | null, metric: Pick<MetricDef, "format" | "good">): Change {
  if (current === null || previous === null) return { text: NONE, tone: "none" }
  const diff = current - previous
  if (Math.abs(diff) < 1e-9) return { text: "no change", tone: "flat" }

  let text: string
  if (metric.format === "percent") text = `${diff > 0 ? "+" : "-"}${Math.abs(diff * 100).toFixed(1)} pts`
  else if (previous === 0) return { text: NONE, tone: "none" }
  else text = `${diff > 0 ? "+" : "-"}${Math.abs((diff / previous) * 100).toFixed(Math.abs(diff / previous) < 0.1 ? 1 : 0)}%`

  const better = metric.good === "none" ? null : metric.good === "up" ? diff > 0 : diff < 0
  return { text, tone: better === null ? "flat" : better ? "good" : "bad" }
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". For the age of the last sync. */
export function formatAgo(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000))
  if (seconds < 45) return "just now"
  if (seconds < 90) return "a minute ago"
  const minutes = Math.round(seconds / 60)
  if (minutes < 45) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours === 1) return "an hour ago"
  if (hours < 36) return `${hours} hours ago`
  return `${Math.round(hours / 24)} days ago`
}
