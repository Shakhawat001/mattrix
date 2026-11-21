import { describe, expect, it } from "vitest"
import { kpis, FLOW_KEYS, STOCK_KEYS, type Flows, type Stocks } from "@/lib/analytics/aggregate"
import { METRICS, metricValue, type MetricId } from "@/lib/analytics/metrics-registry"
import { csvCell, toCsv } from "@/lib/csv"
import { describeChange, formatAxis, formatDays, formatInt, formatMoney, formatPercent, formatValue, NONE } from "@/lib/format"

describe("number formats", () => {
  it("writes money in dollars from cents", () => {
    expect(formatMoney(2499)).toBe("$24.99")
    expect(formatMoney(2000)).toBe("$20")
    expect(formatMoney(123456)).toBe("$1,235")
    expect(formatMoney(-500)).toBe("-$5")
    expect(formatMoney(0)).toBe("$0")
  })
  it("shortens large amounts only when asked", () => {
    expect(formatMoney(12_500_000, { compact: true })).toBe("$125K")
    expect(formatMoney(12_500_000)).toBe("$125,000")
    expect(formatMoney(-12_500_000, { compact: true })).toBe("-$125K")
    expect(formatMoney(5000, { compact: true })).toBe("$50")
  })
  it("writes counts, percentages and days", () => {
    expect(formatInt(12345.6)).toBe("12,346")
    expect(formatPercent(0.1234)).toBe("12.3%")
    expect(formatPercent(1.5, 0)).toBe("150%")
    expect(formatDays(3.04)).toBe("3.0 days")
    expect(formatDays(35.4)).toBe("35 days")
  })
  it("writes n/a for anything that is not a number", () => {
    for (const bad of [null, undefined, NaN, Infinity]) expect(formatValue(bad as number, "int")).toBe(NONE)
    expect(formatValue(0, "int")).toBe("0")
  })
  it("writes short axis ticks", () => {
    expect(formatAxis(2_500_000, "money")).toBe("$25K")
    expect(formatAxis(0.25, "percent")).toBe("25%")
    expect(formatAxis(45_000, "int")).toBe("45K")
    expect(formatAxis(120, "int")).toBe("120")
  })
})

describe("describeChange", () => {
  const up = { format: "int", good: "up" } as const
  const down = { format: "int", good: "down" } as const
  const rate = { format: "percent", good: "down" } as const

  it("is a percentage for counts and amounts, green when up is good", () => {
    expect(describeChange(120, 100, up)).toEqual({ text: "+20%", tone: "good" })
    expect(describeChange(80, 100, up)).toEqual({ text: "-20%", tone: "bad" })
    expect(describeChange(103, 100, up)).toEqual({ text: "+3.0%", tone: "good" })
  })
  it("flips the colour when down is good", () => {
    expect(describeChange(80, 100, down)).toEqual({ text: "-20%", tone: "good" })
    expect(describeChange(120, 100, down)).toEqual({ text: "+20%", tone: "bad" })
  })
  it("is percentage points for rates", () => {
    expect(describeChange(0.12, 0.1, rate)).toEqual({ text: "+2.0 pts", tone: "bad" })
    expect(describeChange(0.08, 0.1, rate)).toEqual({ text: "-2.0 pts", tone: "good" })
  })
  it("says so when there is nothing to compare, instead of inventing a percentage", () => {
    expect(describeChange(5, 0, up)).toEqual({ text: NONE, tone: "none" })
    expect(describeChange(null, 5, up)).toEqual({ text: NONE, tone: "none" })
    expect(describeChange(5, null, up)).toEqual({ text: NONE, tone: "none" })
    expect(describeChange(0, 0, up)).toEqual({ text: "no change", tone: "flat" })
  })
  it("does not colour a change that is neither good nor bad", () => {
    expect(describeChange(120, 100, { format: "int", good: "none" })).toEqual({ text: "+20%", tone: "flat" })
  })
})

describe("the metric registry", () => {
  const zeroF = Object.fromEntries(FLOW_KEYS.map((k) => [k, 0])) as Flows
  const zeroS = Object.fromEntries(STOCK_KEYS.map((k) => [k, 0])) as Stocks
  const sample = kpis({ ...zeroF, installs: 3 }, zeroS, zeroS, 30)

  it("defines every metric with a label, a format and a plain definition", () => {
    for (const [id, def] of Object.entries(METRICS)) {
      expect(def.label, id).toBeTruthy()
      expect(def.description.length, id).toBeGreaterThan(20)
      expect(["int", "money", "percent", "days"]).toContain(def.format)
      expect(["up", "down", "none"]).toContain(def.good)
    }
  })
  it("reads every metric out of the KPIs", () => {
    for (const id of Object.keys(METRICS) as MetricId[]) expect(metricValue(sample, id), id).not.toBeUndefined()
  })
  it("has no dash used as punctuation in any definition", () => {
    for (const [id, def] of Object.entries(METRICS)) expect(def.description, id).not.toMatch(/[—–]| - /)
  })
})

describe("CSV", () => {
  it("quotes values with commas, quotes and line breaks", () => {
    expect(csvCell("a,b")).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell("two\nlines")).toBe('"two\nlines"')
  })
  it("writes numbers, dates, booleans and empties plainly", () => {
    expect(csvCell(-12.5)).toBe("-12.5")
    expect(csvCell(new Date("2026-11-22T10:00:00Z"))).toBe("2026-11-22T10:00:00.000Z")
    expect(csvCell(true)).toBe("true")
    expect(csvCell(null)).toBe("")
    expect(csvCell(undefined)).toBe("")
    expect(csvCell(NaN)).toBe("")
  })
  it("defuses text a spreadsheet would run as a formula", () => {
    for (const text of ["=HYPERLINK(\"http://evil\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      expect(csvCell(text).replace(/^"/, "").startsWith("'"), text).toBe(true)
    }
    expect(csvCell("shop-name.myshopify.com")).toBe("shop-name.myshopify.com")
  })
  it("leaves a negative number a number", () => {
    expect(csvCell(-5)).toBe("-5")
  })
  it("joins rows with CRLF and ends with one", () => {
    expect(toCsv([["a", 1], ["b,c", 2]])).toBe('a,1\r\n"b,c",2\r\n')
  })
})

describe("negative zero", () => {
  it("never prints a minus sign", () => {
    expect(formatMoney(-0)).toBe("$0")
    expect(formatInt(-0)).toBe("0")
    expect(formatPercent(-0)).toBe("0.0%")
    expect(formatValue(-0, "money")).toBe("$0")
  })
})
