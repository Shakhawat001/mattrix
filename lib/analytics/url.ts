import { PRESETS, formatRange, isDate, resolveRange, type Compare, type Range } from "./range"

// The URL is the state: range, comparison, bucket size and apps all live in the query
// string, so any view can be bookmarked or sent to someone else. These helpers are shared by
// the filter bar in the browser and by the pages on the server.

/** The params that follow you from page to page. Everything else (a search box, a page number) stays behind. */
export const CARRIED_PARAMS = ["preset", "from", "to", "compare", "gran"] as const

/** A copy of the query with some params set or removed. An empty or null value removes it. The page number resets unless it is being set. */
export function withParams(current: URLSearchParams | string, updates: Record<string, string | null | undefined>): URLSearchParams {
  const next = new URLSearchParams(typeof current === "string" ? current : current.toString())
  for (const [name, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") next.delete(name)
    else next.set(name, value)
  }
  if (!("page" in updates)) next.delete("page")
  return next
}

/** "?preset=7d&compare=previous" for a link to another page, or "" when nothing is set. */
export function carriedQuery(current: URLSearchParams | string): string {
  const from = new URLSearchParams(typeof current === "string" ? current : current.toString())
  const kept = new URLSearchParams()
  for (const name of CARRIED_PARAMS) {
    const value = from.get(name)
    if (value) kept.set(name, value)
  }
  const text = kept.toString()
  return text ? `?${text}` : ""
}

/** A page's `searchParams` prop as a URLSearchParams, keeping the first value of any repeated name. */
export function toParams(searchParams: Record<string, string | string[] | undefined>): URLSearchParams {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(searchParams)) {
    const first = Array.isArray(value) ? value[0] : value
    if (first) query.set(name, first)
  }
  return query
}

/** The same as `carriedQuery`, from a page's `searchParams` prop, for links a server component renders. */
export function carriedFrom(searchParams: Record<string, string | string[] | undefined>): string {
  return carriedQuery(toParams(searchParams))
}

/** A positive whole number from the query, or 1. */
export function pageNumber(value: string | string[] | undefined): number {
  const text = Array.isArray(value) ? value[0] : value
  const n = Number.parseInt(text ?? "", 10)
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100_000) : 1
}

/** The value if it is one of the allowed ones, otherwise undefined. For filters read from the URL. */
export function oneOf<T extends string>(value: string | string[] | undefined, allowed: readonly T[]): T | undefined {
  const text = Array.isArray(value) ? value[0] : value
  return allowed.find((a) => a === text)
}

export type RangeSelection = {
  /** The range the pages will show, after the same rules the server applies. */
  range: Range
  /** The preset in use, if any. The default is the last 30 days. */
  presetKey: string | null
  /** What the picker button says. */
  label: string
}

export function selectionFrom(get: (name: string) => string | null | undefined, today: string, earliest: string | null): RangeSelection {
  const preset = get("preset") ?? undefined
  const from = get("from") ?? undefined
  const to = get("to") ?? undefined
  const range = resolveRange({ preset, from, to }, today, earliest)

  const known = preset ? PRESETS.find((p) => p.key === preset) : undefined
  if (known) return { range, presetKey: known.key, label: known.label }
  if (isDate(from) && isDate(to)) return { range, presetKey: null, label: formatRange(range) }
  return { range, presetKey: "30d", label: "Last 30 days" }
}

export const COMPARE_OPTIONS: { value: Compare; label: string; short: string }[] = [
  { value: "none", label: "No comparison", short: "" },
  { value: "previous", label: "Previous period", short: "vs previous period" },
  { value: "year", label: "Same period last year", short: "vs same period last year" },
]

export const compareLabel = (compare: Compare): string => COMPARE_OPTIONS.find((o) => o.value === compare)?.short ?? ""
