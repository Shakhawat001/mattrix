import { describe, expect, it } from "vitest"
import {
  addDays,
  autoGranularity,
  bucketKey,
  bucketLabel,
  bucketsIn,
  compareRange,
  dayCount,
  formatRange,
  isDate,
  nextBucket,
  presetRange,
  previousRange,
  resolveRange,
  yearAgoRange,
} from "@/lib/analytics/range"

const TODAY = "2026-11-22" // a Sunday

describe("isDate", () => {
  it("accepts real calendar days only", () => {
    expect(isDate("2026-11-22")).toBe(true)
    expect(isDate("2024-02-29")).toBe(true)
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "22/11/2026", "", "2026-11-22T00:00:00Z", undefined, null]) expect(isDate(bad)).toBe(false)
  })
})

describe("presets", () => {
  const r = (key: string, earliest: string | null = "2025-03-10") => presetRange(key, TODAY, earliest)

  it("counts the last N days with today included", () => {
    expect(r("7d")).toEqual({ from: "2026-11-16", to: TODAY })
    expect(r("30d")).toEqual({ from: "2026-10-24", to: TODAY })
    expect(r("90d")).toEqual({ from: "2026-08-25", to: TODAY })
    expect(r("12m")).toEqual({ from: "2025-11-23", to: TODAY })
    expect(dayCount(r("30d")!)).toBe(30)
  })

  it("knows this month, last month, this quarter and this year", () => {
    expect(r("mtd")).toEqual({ from: "2026-11-01", to: TODAY })
    expect(r("lastmonth")).toEqual({ from: "2026-10-01", to: "2026-10-31" })
    expect(r("qtd")).toEqual({ from: "2026-10-01", to: TODAY })
    expect(r("ytd")).toEqual({ from: "2026-01-01", to: TODAY })
  })

  it("handles last month across a year boundary", () => {
    expect(presetRange("lastmonth", "2026-01-15", null)).toEqual({ from: "2025-12-01", to: "2025-12-31" })
  })

  it("starts 'all time' at the first day with data, or 30 days back if there is none", () => {
    expect(r("all")).toEqual({ from: "2025-03-10", to: TODAY })
    expect(r("all", null)).toEqual({ from: "2026-10-24", to: TODAY })
  })

  it("returns null for a preset it does not know", () => {
    expect(r("nope")).toBeNull()
  })
})

describe("resolveRange", () => {
  const resolve = (p: { from?: string; to?: string; preset?: string }) => resolveRange(p, TODAY, "2025-03-10")

  it("uses a free from and to", () => {
    expect(resolve({ from: "2026-03-01", to: "2026-03-31" })).toEqual({ from: "2026-03-01", to: "2026-03-31" })
  })
  it("lets a preset win", () => {
    expect(resolve({ preset: "7d", from: "2020-01-01", to: "2020-01-31" })).toEqual({ from: "2026-11-16", to: TODAY })
  })
  it("falls back to 30 days for nothing, for junk, and for half a range", () => {
    const thirty = { from: "2026-10-24", to: TODAY }
    expect(resolve({})).toEqual(thirty)
    expect(resolve({ from: "nope", to: "2026-03-01" })).toEqual(thirty)
    expect(resolve({ from: "2026-03-01" })).toEqual(thirty)
    expect(resolve({ preset: "bogus" })).toEqual(thirty)
  })
  it("never ends in the future", () => {
    expect(resolve({ from: "2026-11-01", to: "2027-05-01" })).toEqual({ from: "2026-11-01", to: TODAY })
  })
  it("fixes a range given backwards by collapsing it to its end", () => {
    expect(resolve({ from: "2026-05-10", to: "2026-05-01" })).toEqual({ from: "2026-05-01", to: "2026-05-01" })
  })
  it("caps the span at five years", () => {
    const range = resolve({ from: "2010-01-01", to: "2026-01-01" })
    expect(dayCount(range)).toBe(1830)
    expect(range.to).toBe("2026-01-01")
  })
})

describe("comparison ranges", () => {
  it("the previous range is the same length, right before", () => {
    expect(previousRange({ from: "2026-11-16", to: "2026-11-22" })).toEqual({ from: "2026-11-09", to: "2026-11-15" })
    expect(previousRange({ from: "2026-11-01", to: "2026-11-30" })).toEqual({ from: "2026-10-02", to: "2026-10-31" })
  })
  it("the year-ago range is the same dates a year earlier, even for a leap day", () => {
    expect(yearAgoRange({ from: "2026-11-01", to: "2026-11-22" })).toEqual({ from: "2025-11-01", to: "2025-11-22" })
    expect(yearAgoRange({ from: "2024-02-29", to: "2024-03-10" })).toEqual({ from: "2023-02-28", to: "2023-03-10" })
  })
  it("picks by name", () => {
    const range = { from: "2026-11-16", to: "2026-11-22" }
    expect(compareRange(range, "none")).toBeNull()
    expect(compareRange(range, "previous")).toEqual(previousRange(range))
    expect(compareRange(range, "year")).toEqual(yearAgoRange(range))
  })
})

describe("granularity and buckets", () => {
  const span = (days: number) => ({ from: addDays(TODAY, -(days - 1)), to: TODAY })

  it("chooses days, then weeks, then months as the range grows", () => {
    expect(autoGranularity(span(45))).toBe("day")
    expect(autoGranularity(span(46))).toBe("week")
    expect(autoGranularity(span(270))).toBe("week")
    expect(autoGranularity(span(271))).toBe("month")
  })

  it("puts a date in its day, its Monday or its month", () => {
    expect(bucketKey("2026-11-22", "day")).toBe("2026-11-22")
    expect(bucketKey("2026-11-22", "week")).toBe("2026-11-16") // Sunday belongs to the week before
    expect(bucketKey("2026-11-23", "week")).toBe("2026-11-23") // Monday starts its own
    expect(bucketKey("2026-11-22", "month")).toBe("2026-11-01")
  })

  it("steps from one bucket to the next, over month and year ends", () => {
    expect(nextBucket("2026-11-16", "week")).toBe("2026-11-23")
    expect(nextBucket("2026-12-01", "month")).toBe("2027-01-01")
    expect(nextBucket("2026-12-31", "day")).toBe("2027-01-01")
  })

  it("lists every bucket a range touches, including partial ones at the ends", () => {
    expect(bucketsIn({ from: "2026-11-18", to: "2026-11-25" }, "week")).toEqual(["2026-11-16", "2026-11-23"])
    expect(bucketsIn({ from: "2026-10-20", to: "2026-12-05" }, "month")).toEqual(["2026-10-01", "2026-11-01", "2026-12-01"])
    expect(bucketsIn({ from: "2026-11-20", to: "2026-11-22" }, "day")).toEqual(["2026-11-20", "2026-11-21", "2026-11-22"])
  })

  it("labels buckets for an axis, and ranges for a heading", () => {
    expect(bucketLabel("2026-11-16", "day")).toBe("Nov 16")
    expect(bucketLabel("2026-11-01", "month")).toBe("Nov 2026")
    expect(formatRange({ from: "2026-11-01", to: "2026-11-22" })).toBe("Nov 1, 2026 to Nov 22, 2026")
    expect(formatRange({ from: "2026-11-01", to: "2026-11-01" })).toBe("Nov 1, 2026")
  })
})
