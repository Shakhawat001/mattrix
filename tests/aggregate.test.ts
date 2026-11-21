import { describe, expect, it } from "vitest"
import {
  FLOW_KEYS,
  STOCK_KEYS,
  bucketSeries,
  cohortRetention,
  addRetention,
  kpis,
  kpisFor,
  noRetention,
  seriesByApp,
  stocksAt,
  sumFlows,
  type DayRow,
  type Flows,
  type Retention,
  type Stocks,
} from "@/lib/analytics/aggregate"

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>
const row = (appId: string, date: string, over: Partial<Flows & Stocks> = {}): DayRow => ({ appId, date, ...zero(FLOW_KEYS), ...zero(STOCK_KEYS), ...over })

describe("sumFlows", () => {
  const rows = [
    row("a", "2026-11-01", { installs: 2, chargedCents: 500 }),
    row("a", "2026-11-02", { installs: 3 }),
    row("b", "2026-11-02", { installs: 4, uninstalls: 1 }),
    row("a", "2026-11-03", { installs: 100 }),
  ]
  it("adds what happened inside the range, across apps, and nothing outside it", () => {
    const total = sumFlows(rows, { from: "2026-11-01", to: "2026-11-02" })
    expect(total.installs).toBe(9)
    expect(total.uninstalls).toBe(1)
    expect(total.chargedCents).toBe(500)
  })
})

describe("stocksAt", () => {
  const rows = [
    row("a", "2026-11-01", { activeInstalls: 10, mrrCents: 1000 }),
    row("a", "2026-11-03", { activeInstalls: 12, mrrCents: 1500 }),
    row("b", "2026-11-02", { activeInstalls: 5, mrrCents: 200 }),
  ]
  it("reads each app's latest row on or before the day and adds them", () => {
    expect(stocksAt(rows, "2026-11-02")).toMatchObject({ activeInstalls: 15, mrrCents: 1200 })
    expect(stocksAt(rows, "2026-11-03")).toMatchObject({ activeInstalls: 17, mrrCents: 1700 })
  })
  it("carries a stock forward past an app's last row, and is zero before its first", () => {
    expect(stocksAt(rows, "2026-12-31")).toMatchObject({ activeInstalls: 17 })
    expect(stocksAt(rows, "2026-10-31")).toMatchObject({ activeInstalls: 0, mrrCents: 0 })
    expect(stocksAt(rows, "2026-11-01")).toMatchObject({ activeInstalls: 10 })
  })
})

describe("kpis", () => {
  // Start: 100 installs, 10 subscribers, $100 MRR. Thirty days later: 120, 11, $123.
  const flows = {
    ...zero(FLOW_KEYS),
    installs: 30, uninstalls: 10, canceledSubs: 2, newSubs: 3,
    newMrrCents: 3000, expansionMrrCents: 500, contractionMrrCents: 200, churnedMrrCents: 1000,
    trialsConverted: 3, trialsCanceled: 1, trialsStarted: 6,
    grossEarnedCents: 10000, feeCents: 290, netEarnedCents: 9710,
  } as Flows
  const start = { ...zero(STOCK_KEYS), activeInstalls: 100, activeSubs: 10, mrrCents: 10000, trialSubs: 2, trialMrrCents: 2000 } as Stocks
  const end = { ...zero(STOCK_KEYS), activeInstalls: 120, activeSubs: 11, mrrCents: 12300, trialSubs: 1, trialMrrCents: 1000 } as Stocks
  // Of the 100 shops and 10 subscribers there at the start: 90 shops and 8 subscribers are still there.
  // The 10 subscribers paid $100; the same ones pay $93 now, of which $88 is not an upgrade.
  const retention: Retention = { startInstalls: 100, keptInstalls: 90, startSubs: 10, keptSubs: 8, startMrr: 10000, endMrr: 9300, keptMrr: 8800 }
  const k = kpis(flows, start, end, 30, retention)

  it("nets installs", () => {
    expect(k.netInstalls).toBe(20)
    expect(k.installs).toBe(30)
    expect(k.uninstalls).toBe(10)
  })
  it("measures the uninstall rate on the shops that were there at the start", () => {
    expect(k.uninstallRate).toBeCloseTo(0.1)
  })
  it("books MRR movement and ties it to the change in MRR", () => {
    expect(k.netNewMrr).toBe(2300)
    expect(k.mrrChange).toBe(2300)
    expect(k.mrrChangePct).toBeCloseTo(0.23)
    expect(k.arr).toBe(12300 * 12)
  })
  it("reads retention and churn from the starting group", () => {
    expect(k.nrr).toBeCloseTo(0.93)
    expect(k.grr).toBeCloseTo(0.88)
    expect(k.revenueChurnRate).toBeCloseTo(0.12)
    expect(k.subChurnRate).toBeCloseTo(0.2)
  })
  it("keeps revenue churn and gross retention as exact opposites", () => {
    expect((k.grr as number) + (k.revenueChurnRate as number)).toBeCloseTo(1)
  })
  it("still reports how many cancellations happened", () => {
    expect(k.canceledSubs).toBe(2)
  })
  it("computes ARPU, and a rough lifetime value from a month's churn", () => {
    expect(k.arpu).toBeCloseTo(12300 / 11)
    expect(k.ltv).toBeCloseTo(12300 / 11 / 0.2)
  })
  it("restates churn over a longer range per 30 days before using it for the lifetime value", () => {
    const ninety = kpis(flows, start, end, 90, retention)
    const monthly = 1 - 0.8 ** (30 / 90)
    expect(ninety.ltv).toBeCloseTo(12300 / 11 / monthly)
    // The same churn spread over a quarter is a gentler month, so the estimate is longer.
    expect(ninety.ltv as number).toBeGreaterThan(k.ltv as number)
  })
  it("measures trial conversion among trials that ended one way or the other", () => {
    expect(k.trialConversion).toBeCloseTo(0.75)
  })
  it("measures Shopify's fee as a share of what was earned", () => {
    expect(k.feeRate).toBeCloseTo(0.029)
  })

  it("answers null, not NaN or Infinity, when there is nothing to divide by", () => {
    const nothing = kpis(zero(FLOW_KEYS) as Flows, zero(STOCK_KEYS) as Stocks, zero(STOCK_KEYS) as Stocks, 30, noRetention())
    for (const key of ["uninstallRate", "mrrChangePct", "nrr", "grr", "subChurnRate", "revenueChurnRate", "arpu", "ltv", "trialConversion", "feeRate"] as const) {
      expect(nothing[key], key).toBeNull()
    }
    expect(Object.values(nothing).every((v) => v === null || Number.isFinite(v))).toBe(true)
  })

  it("leaves the retention rates empty when it is not given the starting group, rather than guessing from flows", () => {
    const without = kpis(flows, start, end, 30)
    for (const key of ["uninstallRate", "nrr", "grr", "subChurnRate", "revenueChurnRate", "ltv"] as const) expect(without[key], key).toBeNull()
    expect(without.mrr).toBe(12300)
  })

  it("has no lifetime value when nobody from the starting group left", () => {
    expect(kpis(flows, start, end, 30, { ...retention, keptSubs: 10 }).ltv).toBeNull()
  })

  it("lets net retention pass 100% when upgrades outweigh losses, but never gross retention", () => {
    const growing = kpis(flows, start, end, 30, { ...retention, endMrr: 11500, keptMrr: 9500 })
    expect(growing.nrr).toBeCloseTo(1.15)
    expect(growing.grr).toBeCloseTo(0.95)
  })
})

describe("retention of the starting group", () => {
  const start = { ...zero(STOCK_KEYS), activeSubs: 5, mrrCents: 5000 } as Stocks
  const end = { ...zero(STOCK_KEYS), activeSubs: 5, mrrCents: 5000 } as Stocks

  it("cannot pass 100% churn, however many subscribers join and leave inside the range", () => {
    // Five subscribers at the start, all still there. Forty more joined and all forty left within the quarter.
    const busy = { ...zero(FLOW_KEYS), newSubs: 40, canceledSubs: 40, newMrrCents: 40000, churnedMrrCents: 40000 } as Flows
    const k = kpis(busy, start, end, 90, { ...noRetention(), startSubs: 5, keptSubs: 5, startMrr: 5000, endMrr: 5000, keptMrr: 5000 })
    expect(k.subChurnRate).toBe(0)
    expect(k.revenueChurnRate).toBe(0)
    expect(k.nrr).toBe(1)
    // The events themselves are still counted.
    expect(k.canceledSubs).toBe(40)
  })

  it("is 100% churn, not more, when every starting subscriber left", () => {
    const k = kpis(zero(FLOW_KEYS) as Flows, start, end, 30, { ...noRetention(), startSubs: 5, keptSubs: 0, startMrr: 5000, endMrr: 0, keptMrr: 0 })
    expect(k.subChurnRate).toBe(1)
    expect(k.nrr).toBe(0)
    expect(k.grr).toBe(0)
    expect(k.revenueChurnRate).toBe(1)
  })

  it("adds the groups of several apps", () => {
    const a: Retention = { startInstalls: 10, keptInstalls: 9, startSubs: 2, keptSubs: 1, startMrr: 2000, endMrr: 1500, keptMrr: 1000 }
    const b: Retention = { startInstalls: 30, keptInstalls: 21, startSubs: 8, keptSubs: 8, startMrr: 8000, endMrr: 9000, keptMrr: 8000 }
    expect(addRetention([a, b])).toEqual({ startInstalls: 40, keptInstalls: 30, startSubs: 10, keptSubs: 9, startMrr: 10000, endMrr: 10500, keptMrr: 9000 })
    expect(addRetention([])).toEqual(noRetention())
  })
})

describe("kpisFor", () => {
  it("reads the starting stock from the day before the range", () => {
    const rows = [
      row("a", "2026-10-31", { activeInstalls: 10, mrrCents: 1000 }),
      row("a", "2026-11-01", { installs: 5, activeInstalls: 15, mrrCents: 1000 }),
      row("a", "2026-11-02", { uninstalls: 1, activeInstalls: 14, mrrCents: 1000 }),
    ]
    const k = kpisFor(rows, { from: "2026-11-01", to: "2026-11-02" })
    expect(k.activeInstallsStart).toBe(10)
    expect(k.activeInstalls).toBe(14)
    expect(k.installs).toBe(5)
  })
})

describe("bucketSeries", () => {
  const rows = [
    row("a", "2026-11-16", { installs: 1, activeInstalls: 10 }),
    row("a", "2026-11-18", { installs: 2, activeInstalls: 12 }),
    row("b", "2026-11-18", { installs: 4, activeInstalls: 20 }),
    row("a", "2026-11-23", { installs: 8, activeInstalls: 20 }),
    row("b", "2026-11-23", { installs: 16, activeInstalls: 36 }),
    row("a", "2026-11-24", { installs: 32, activeInstalls: 52 }),
  ]

  it("sums flows into each bucket and reads stocks at the end of it", () => {
    const series = bucketSeries(rows, { from: "2026-11-16", to: "2026-11-29" }, "week")
    expect(series.map((p) => p.bucket)).toEqual(["2026-11-16", "2026-11-23"])
    expect(series[0].installs).toBe(7)
    expect(series[0].activeInstalls).toBe(12 + 20) // a at the 18th, b at the 18th
    expect(series[1].installs).toBe(56)
    expect(series[1].activeInstalls).toBe(52 + 36)
  })

  it("reads the last bucket's stock at the end of the range, not the end of the bucket", () => {
    const series = bucketSeries(rows, { from: "2026-11-16", to: "2026-11-23" }, "week")
    expect(series[1].activeInstalls).toBe(20 + 36)
  })

  it("leaves no gaps: an empty bucket is zeros for flows and carries the stock", () => {
    const series = bucketSeries([row("a", "2026-11-01", { installs: 1, activeInstalls: 5 })], { from: "2026-11-01", to: "2026-11-03" }, "day")
    expect(series.map((p) => [p.bucket, p.installs, p.activeInstalls])).toEqual([
      ["2026-11-01", 1, 5],
      ["2026-11-02", 0, 5],
      ["2026-11-03", 0, 5],
    ])
  })

  it("ignores rows outside the range", () => {
    const series = bucketSeries(rows, { from: "2026-11-18", to: "2026-11-18" }, "day")
    expect(series).toHaveLength(1)
    expect(series[0].installs).toBe(6)
  })
})

describe("seriesByApp", () => {
  const rows = [
    row("a", "2026-11-01", { installs: 1, mrrCents: 100 }),
    row("b", "2026-11-01", { installs: 2, mrrCents: 200 }),
    row("a", "2026-11-02", { installs: 3, mrrCents: 150 }),
  ]
  it("gives one value per app per bucket: flows summed, stocks read at the end", () => {
    const flows = seriesByApp(rows, { from: "2026-11-01", to: "2026-11-02" }, "day", "installs")
    expect(flows).toEqual([
      { bucket: "2026-11-01", values: { a: 1, b: 2 } },
      { bucket: "2026-11-02", values: { a: 3, b: 0 } },
    ])
    const stocks = seriesByApp(rows, { from: "2026-11-01", to: "2026-11-02" }, "day", "mrrCents")
    expect(stocks[1].values).toEqual({ a: 150, b: 200 })
  })
})

describe("cohortRetention", () => {
  const day = (iso: string) => new Date(`${iso}T12:00:00Z`)
  const stays = [
    { installedAt: day("2026-11-02"), uninstalledAt: day("2026-11-05") }, // gone inside week 0
    { installedAt: day("2026-11-03"), uninstalledAt: day("2026-11-12") }, // gone inside week 1
    { installedAt: day("2026-11-04"), uninstalledAt: null },
    { installedAt: day("2026-11-08"), uninstalledAt: null },
    { installedAt: day("2026-11-16"), uninstalledAt: null }, // next cohort
  ]
  const now = new Date("2026-11-22T12:00:00Z") // a Sunday: the week of the 16th is just over

  it("measures the share still installed at the end of each week since the cohort's first", () => {
    const [first] = cohortRetention(stays, "week", now)
    expect(first.cohort).toBe("2026-11-02")
    expect(first.size).toBe(4)
    expect(first.cells[0]).toBeCloseTo(0.75) // end of week 0 (9 Nov): the first one has left
    expect(first.cells[1]).toBeCloseTo(0.5) // end of week 1 (16 Nov): the second has left too
    expect(first.cells[2]).toBeCloseTo(0.5) // end of week 2 is today
  })

  it("leaves a period empty until it has fully passed", () => {
    const [first, second] = cohortRetention(stays, "week", now)
    expect(first.cells[3]).toBeNull()
    expect(second.cohort).toBe("2026-11-16")
    expect(second.cells[0]).toBe(1)
    expect(second.cells[1]).toBeNull()
  })

  it("orders cohorts oldest first and fills every row to the requested length", () => {
    const rows = cohortRetention(stays, "week", now, 5)
    expect(rows.map((r) => r.cohort)).toEqual(["2026-11-02", "2026-11-16"])
    expect(rows.every((r) => r.cells.length === 5)).toBe(true)
  })

  it("groups by month too", () => {
    const [nov] = cohortRetention(stays, "month", new Date("2026-12-15T12:00:00Z"))
    expect(nov.cohort).toBe("2026-11-01")
    expect(nov.size).toBe(5)
    expect(nov.cells[0]).toBeCloseTo(3 / 5) // end of November: two of five are gone
    expect(nov.cells[1]).toBeNull() // December is not over
  })

  it("returns nothing for no installs", () => {
    expect(cohortRetention([], "week", now)).toEqual([])
  })
})
