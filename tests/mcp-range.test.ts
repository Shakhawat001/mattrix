import { describe, expect, it } from "vitest"
import { z } from "zod"
import { COMPARE_INPUT, RANGE_INPUT, RANGE_PRESETS, toolRange, type RangeInput } from "@/lib/mcp/range"
import { ToolError } from "@/lib/mcp/tool"

const TODAY = "2026-11-22"
const EARLIEST = "2025-03-10"
const range = (input: RangeInput, earliest: string | null = EARLIEST) => toolRange(input, TODAY, earliest)
const refused = (input: RangeInput) => {
  try {
    range(input)
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    return (error as Error).message
  }
  throw new Error("expected a ToolError")
}

describe("toolRange", () => {
  it("defaults to the last 30 days, and says so", () => {
    const r = range({})
    expect(r.range).toEqual({ from: "2026-10-24", to: TODAY })
    expect(r.compared).toBeNull()
    expect(r.comparison).toBe("none")
    expect(r.notes).toEqual(["No range was given, so this is the last 30 days, 2026-10-24 to 2026-11-22."])
  })

  it("reads every preset the way the dashboard does", () => {
    const expected: Record<(typeof RANGE_PRESETS)[number], { from: string; to: string }> = {
      last_7_days: { from: "2026-11-16", to: TODAY },
      last_30_days: { from: "2026-10-24", to: TODAY },
      last_90_days: { from: "2026-08-25", to: TODAY },
      this_month: { from: "2026-11-01", to: TODAY },
      last_month: { from: "2026-10-01", to: "2026-10-31" },
      last_12_months: { from: "2025-11-23", to: TODAY },
      year_to_date: { from: "2026-01-01", to: TODAY },
      all_time: { from: EARLIEST, to: TODAY },
    }
    for (const preset of RANGE_PRESETS) {
      const r = range({ preset })
      expect(r.range, preset).toEqual(expected[preset])
      expect(r.notes, preset).toEqual([])
    }
  })

  it("starts all_time 30 days back when there is no data yet, and says so", () => {
    const r = range({ preset: "all_time" }, null)
    expect(r.range).toEqual({ from: "2026-10-24", to: TODAY })
    expect(r.notes).toEqual(["There is no data yet, so all_time covers the last 30 days."])
  })

  it("takes from and to, both ends included", () => {
    expect(range({ from: "2026-02-01", to: "2026-02-28" }).range).toEqual({ from: "2026-02-01", to: "2026-02-28" })
    expect(range({ from: TODAY, to: TODAY }).range).toEqual({ from: TODAY, to: TODAY })
  })

  it("ends a range on today when it was asked to end later, and says so", () => {
    const r = range({ from: "2026-11-01", to: "2026-12-31" })
    expect(r.range).toEqual({ from: "2026-11-01", to: TODAY })
    expect(r.notes).toEqual(["The range was asked to end on 2026-12-31, after today, so it ends today, 2026-11-22."])
  })

  it("caps a range at five years, and says so", () => {
    const r = range({ from: "2015-01-01", to: "2026-11-22" })
    expect(r.range).toEqual({ from: "2021-11-19", to: TODAY })
    expect(r.notes).toEqual(["The range was longer than five years, so it starts on 2021-11-19 (1830 days)."])
  })

  it("refuses input it cannot read, saying what to do instead", () => {
    expect(refused({ preset: "last_7_days", from: "2026-11-01", to: "2026-11-02" })).toBe("Give either a preset or from and to, not both.")
    expect(refused({ from: "2026-11-01" })).toBe("Give both from and to (YYYY-MM-DD), or a preset.")
    expect(refused({ to: "2026-11-01" })).toBe("Give both from and to (YYYY-MM-DD), or a preset.")
    expect(refused({ from: "2026-11-10", to: "2026-11-01" })).toBe("from (2026-11-10) is after to (2026-11-01).")
    expect(refused({ from: "2026-02-30", to: "2026-03-01" })).toBe("2026-02-30 is not a day. Write it as YYYY-MM-DD.")
    expect(refused({ from: "2026-12-01", to: "2026-12-05" })).toBe("The range starts after today, 2026-11-22 (UTC). There is no data for it yet.")
  })

  it("compares with the period before, the same days a year earlier, or nothing", () => {
    expect(range({ from: "2026-11-01", to: "2026-11-10", compare: "previous_period" }).compared).toEqual({ from: "2026-10-22", to: "2026-10-31" })
    expect(range({ from: "2024-02-01", to: "2024-02-29", compare: "previous_year" }).compared).toEqual({ from: "2023-02-01", to: "2023-02-28" })
    expect(range({ preset: "last_7_days", compare: "none" }).compared).toBeNull()
    expect(range({ preset: "last_7_days", compare: "previous_year" }).comparison).toBe("previous_year")
  })
})

describe("the range input schema", () => {
  const schema = z.object({ ...RANGE_INPUT, ...COMPARE_INPUT })

  it("accepts the presets, real days and the comparisons", () => {
    expect(schema.safeParse({ preset: "year_to_date", compare: "previous_period" }).success).toBe(true)
    expect(schema.safeParse({ from: "2024-02-29", to: "2024-03-01" }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(true)
  })

  it("refuses an unknown preset or comparison and a day that does not exist", () => {
    expect(schema.safeParse({ preset: "7d" }).success).toBe(false)
    expect(schema.safeParse({ compare: "year" }).success).toBe(false)
    expect(schema.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success).toBe(false)
    expect(schema.safeParse({ from: "22/11/2026", to: "2026-11-22" }).success).toBe(false)
  })
})
