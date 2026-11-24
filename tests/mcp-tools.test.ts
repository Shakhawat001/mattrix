import { describe, expect, it } from "vitest"
import { kpis, noRetention, FLOW_KEYS, STOCK_KEYS, type Flows, type Stocks } from "@/lib/analytics/aggregate"
import { COHORT_METRICS, METRICS } from "@/lib/analytics/metrics-registry"
import { changeOf, cohortMetricAnswer, metricAnswer, RANGE_METRIC_IDS, READS_RETENTION } from "@/lib/mcp/metrics"
import { billing, reasonLabels } from "@/lib/mcp/output"
import { bucketRanges } from "@/lib/mcp/tools/get-timeseries"

const flows = (over: Partial<Flows> = {}): Flows => ({ ...(Object.fromEntries(FLOW_KEYS.map((k) => [k, 0])) as Flows), ...over })
const stocks = (over: Partial<Stocks> = {}): Stocks => ({ ...(Object.fromEntries(STOCK_KEYS.map((k) => [k, 0])) as Stocks), ...over })

describe("the metrics the tools serve", () => {
  it("are every metric of the registry", () => {
    expect(RANGE_METRIC_IDS).toEqual(Object.keys(METRICS))
  })

  it("know which ones follow the starting shops, by asking kpis()", () => {
    expect([...READS_RETENTION].sort()).toEqual(["grr", "ltv", "nrr", "revenueChurnRate", "subChurnRate", "uninstallRate"])
  })
})

describe("a metric's answer", () => {
  const now = kpis(flows({ installs: 12, newMrrCents: 5000 }), stocks({ mrrCents: 100_000, activeSubs: 40 }), stocks({ mrrCents: 110_000, activeSubs: 44 }), 30, {
    ...noRetention(),
    startSubs: 40,
    keptSubs: 38,
    startMrr: 100_000,
    endMrr: 104_000,
    keptMrr: 98_000,
  })
  const before = kpis(flows({ installs: 0, newMrrCents: 2500 }), stocks({ mrrCents: 90_000, activeSubs: 38 }), stocks({ mrrCents: 100_000, activeSubs: 40 }), 30, {
    ...noRetention(),
    startSubs: 38,
    keptSubs: 35,
    startMrr: 90_000,
    endMrr: 90_000,
    keptMrr: 88_000,
  })

  it("has the registry's label, unit, direction and definition, and the value written by its format", () => {
    expect(metricAnswer("mrr", now, null)).toEqual({
      id: "mrr",
      label: "MRR",
      unit: "US dollars",
      value: { cents: 110_000, formatted: "$1,100" },
      better_when: "higher",
      definition: METRICS.mrr.description,
    })
    expect(metricAnswer("subChurnRate", now, null).value).toEqual({ ratio: 0.05, formatted: "5.0%" })
  })

  it("adds the previous value and the change only when the range is compared", () => {
    const mrr = metricAnswer("mrr", now, before)
    expect(Object.keys(mrr)).toEqual(["id", "label", "unit", "value", "previous", "change", "better_when", "definition"])
    expect(mrr.previous).toEqual({ cents: 100_000, formatted: "$1,000" })
    expect(mrr.change).toEqual({ difference: { cents: 10_000, formatted: "$100" }, formatted: "+10%", better: true })
    expect("previous" in metricAnswer("mrr", now, null)).toBe(false)
  })

  it("changes a rate by points, and calls a fall in churn better", () => {
    // 2 of 40 left (5%), against 3 of 38 (7.9%).
    expect(metricAnswer("subChurnRate", now, before).change).toEqual({ difference: { ratio: -0.028947, formatted: "-2.9%" }, formatted: "-2.9 pts", better: true })
  })

  it("has no percentage for a change from zero, but still knows whether it is better", () => {
    expect(metricAnswer("installs", now, before).change).toEqual({ difference: { count: 12, formatted: "12" }, formatted: null, better: true })
  })

  it("says no change, better or worse, when nothing moved", () => {
    expect(changeOf(5, 5, METRICS.installs)).toEqual({ difference: { count: 0, formatted: "0" }, formatted: "no change", better: null })
    expect(changeOf(1, 2, COHORT_METRICS.daysToReturn)?.better).toBeNull()
  })

  it("has no change when either value has nothing to divide by", () => {
    const empty = kpis(flows(), stocks(), stocks(), 30, noRetention())
    expect(metricAnswer("subChurnRate", empty, before)).toMatchObject({ value: null, previous: { ratio: 0.078947 }, change: null })
  })

  it("writes the numbers that follow a group up to today, which have no comparison", () => {
    expect(cohortMetricAnswer("winBackRate", 0.25)).toEqual({
      id: "winBackRate",
      label: "Win-back rate",
      unit: "percent",
      value: { ratio: 0.25, formatted: "25.0%" },
      better_when: "higher",
      definition: COHORT_METRICS.winBackRate.description,
    })
    expect(cohortMetricAnswer("daysToReturn", null).value).toBeNull()
  })
})

describe("timeseries buckets", () => {
  it("cut the first and last week to the range", () => {
    // 2026-11-04 is a Wednesday; weeks start on Monday.
    expect(bucketRanges({ from: "2026-11-04", to: "2026-11-18" }, "week")).toEqual([
      { bucket: "2026-11-02", from: "2026-11-04", to: "2026-11-08" },
      { bucket: "2026-11-09", from: "2026-11-09", to: "2026-11-15" },
      { bucket: "2026-11-16", from: "2026-11-16", to: "2026-11-18" },
    ])
  })

  it("follow calendar months and single days", () => {
    expect(bucketRanges({ from: "2024-01-15", to: "2024-03-10" }, "month")).toEqual([
      { bucket: "2024-01-01", from: "2024-01-15", to: "2024-01-31" },
      { bucket: "2024-02-01", from: "2024-02-01", to: "2024-02-29" },
      { bucket: "2024-03-01", from: "2024-03-01", to: "2024-03-10" },
    ])
    expect(bucketRanges({ from: "2026-11-01", to: "2026-11-02" }, "day")).toEqual([
      { bucket: "2026-11-01", from: "2026-11-01", to: "2026-11-01" },
      { bucket: "2026-11-02", from: "2026-11-02", to: "2026-11-02" },
    ])
  })
})

describe("words the tools share", () => {
  it("say a billing period the dashboard's way", () => {
    expect(billing("ANNUAL")).toBe("yearly")
    expect(billing("EVERY_30_DAYS")).toBe("monthly")
    expect(billing(null)).toBeNull()
  })

  it("turn Shopify's reason codes into the dashboard's words", () => {
    expect(reasonLabels("app_not_working, too_expensive")).toEqual(["App not working", "Too expensive"])
    expect(reasonLabels("No reason given")).toEqual(["No reason given"])
    expect(reasonLabels(null)).toEqual([])
    expect(reasonLabels(" , ")).toEqual([])
  })
})
