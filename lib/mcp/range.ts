import { z } from "zod"
import { addDays, compareRange, dayCount, isDate, presetRange, resolveRange, type Compare, type Range } from "@/lib/analytics/range"
import { ToolError } from "./tool"

// The date range a tool reads, from its input: from and to, or a named preset, plus an optional
// comparison. It follows the dashboard's rules (lib/analytics/range.ts): days are days in the dashboard's time zone, both ends
// are included, the end is never after today and the span is at most five years. Unlike a page,
// which quietly falls back to the last 30 days, a tool says what is wrong so the agent can retry,
// and notes anything it had to change.
//
// A tool spreads the fields into its schema, z.object({ ...RANGE_INPUT, ...COMPARE_INPUT, ... }),
// then calls toolRange(input, todayIn(timeZone, ctx.now), earliest) and passes the result's range, compared
// range and notes to envelope().

export const RANGE_PRESETS = ["last_7_days", "last_30_days", "last_90_days", "this_month", "last_month", "last_12_months", "year_to_date", "all_time"] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]

export const COMPARISONS = ["previous_period", "previous_year", "none"] as const
export type Comparison = (typeof COMPARISONS)[number]

/** The dashboard's preset for each name an agent uses. */
const PRESET_KEYS: Record<RangePreset, string> = {
  last_7_days: "7d",
  last_30_days: "30d",
  last_90_days: "90d",
  this_month: "mtd",
  last_month: "lastmonth",
  last_12_months: "12m",
  year_to_date: "ytd",
  all_time: "all",
}

const COMPARE_KEYS: Record<Comparison, Compare> = { previous_period: "previous", previous_year: "year", none: "none" }

export const DEFAULT_PRESET: RangePreset = "last_30_days"

const day = z.string().refine((value) => isDate(value), "Write a real day as YYYY-MM-DD.")

export const RANGE_INPUT = {
  preset: z
    .enum(RANGE_PRESETS)
    .optional()
    .describe("A named range that ends today (in the dashboard's time zone, the timezone of every answer). all_time starts at the first day with data. Leave it out when you give from and to. Default: last_30_days."),
  from: day.optional().describe("The first day of the range, YYYY-MM-DD, a day in the dashboard's time zone. Give it together with to."),
  to: day.optional().describe("The last day of the range, included, YYYY-MM-DD, a day in the dashboard's time zone. A day after today counts as today."),
}

export const COMPARE_INPUT = {
  compare: z
    .enum(COMPARISONS)
    .optional()
    .describe("What to compare with: previous_period (the same number of days just before), previous_year (the same days a year earlier) or none. Default: none."),
}

export type RangeInput = { preset?: RangePreset; from?: string; to?: string; compare?: Comparison }

export type ToolRange = {
  range: Range
  /** The range to compare with, or null. */
  compared: Range | null
  comparison: Comparison
  /** What was assumed or changed, as sentences for the envelope's notes. */
  notes: string[]
}

/** The range a tool reads. `earliest` is the first day with data for the apps it reads, for all_time. Throws a ToolError for input that cannot be read. */
export function toolRange(input: RangeInput, today: string, earliest: string | null): ToolRange {
  const notes: string[] = []
  const comparison = input.compare ?? "none"
  const hasDays = input.from !== undefined || input.to !== undefined

  if (input.preset && hasDays) throw new ToolError("Give either a preset or from and to, not both.")
  if (hasDays && (input.from === undefined || input.to === undefined)) throw new ToolError("Give both from and to (YYYY-MM-DD), or a preset.")
  for (const value of [input.from, input.to]) if (value !== undefined && !isDate(value)) throw new ToolError(`${value} is not a day. Write it as YYYY-MM-DD.`)

  let asked: Range
  if (input.from !== undefined && input.to !== undefined) {
    if (input.from > input.to) throw new ToolError(`from (${input.from}) is after to (${input.to}).`)
    if (input.from > today) throw new ToolError(`The range starts after today, ${today}. There is no data for it yet.`)
    asked = { from: input.from, to: input.to }
  } else {
    const preset = input.preset ?? DEFAULT_PRESET
    if (!input.preset) notes.push(`No range was given, so this is the last 30 days, ${addDays(today, -29)} to ${today}.`)
    if (preset === "all_time" && earliest === null) notes.push("There is no data yet, so all_time covers the last 30 days.")
    asked = presetRange(PRESET_KEYS[preset], today, earliest) as Range
  }

  const range = resolveRange(asked, today, earliest)
  if (range.to !== asked.to) notes.push(`The range was asked to end on ${asked.to}, after today, so it ends today, ${range.to}.`)
  if (range.from !== asked.from) notes.push(`The range was longer than five years, so it starts on ${range.from} (${dayCount(range)} days).`)

  return { range, compared: compareRange(range, COMPARE_KEYS[comparison]), comparison, notes }
}
