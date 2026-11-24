import { describe, expect, it } from "vitest"
import { FLOW_KEYS, STOCK_KEYS, kpis, bucketSeries, type DayRow, type Flows, type Stocks } from "@/lib/analytics/aggregate"
import { METRICS, type MetricId } from "@/lib/analytics/metrics-registry"
import { OTHER_COLOR, OTHER_KEY, SLOT_COUNT, appColors, appSeries, slotColor, swatchColor } from "@/lib/analytics/series"
import { CARRIED_PARAMS, carriedQuery, compareLabel, selectionFrom, withParams } from "@/lib/analytics/url"
import { SPARK, bucketTitle, byApp, readers, single, sparkValues, totals, CHURN_BY_CAUSE, INSTALLS_AND_UNINSTALLS, MRR_MOVEMENT } from "@/lib/analytics/view"

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>
const row = (appId: string, date: string, over: Partial<Flows & Stocks> = {}): DayRow => ({ appId, date, ...zero(FLOW_KEYS), ...zero(STOCK_KEYS), ...over })
const app = (id: string, minute: number, color: string | null = null) => ({ id, label: `App ${id}`, color, createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)) })

describe("app colors", () => {
  it("hands out slots in the order apps were created", () => {
    const colors = appColors([app("b", 2), app("a", 1), app("c", 3)])
    expect(colors.get("a")).toBe(slotColor(0))
    expect(colors.get("b")).toBe(slotColor(1))
    expect(colors.get("c")).toBe(slotColor(2))
  })

  it("keeps an app's color when others are hidden or filtered out, because every app counts", () => {
    const all = [app("a", 1), app("b", 2), app("c", 3)]
    const before = appColors(all).get("c")
    // Hiding or filtering changes which apps are drawn, never the list the slots come from.
    const drawn = appSeries([all[2]], appColors(all))
    expect(drawn.series[0].color).toBe(before)
  })

  it("does not repaint older apps when a new one arrives", () => {
    const before = appColors([app("a", 1), app("b", 2)])
    const after = appColors([app("a", 1), app("b", 2), app("c", 3)])
    expect(after.get("a")).toBe(before.get("a"))
    expect(after.get("b")).toBe(before.get("b"))
  })

  it("never generates a ninth hue: later apps have none and fold into Other", () => {
    const all = Array.from({ length: SLOT_COUNT + 2 }, (_, i) => app(`app${i}`, i))
    const colors = appColors(all)
    expect(colors.get(`app${SLOT_COUNT - 1}`)).toBe(slotColor(SLOT_COUNT - 1))
    expect(colors.get(`app${SLOT_COUNT}`)).toBeNull()
    expect(swatchColor(colors, `app${SLOT_COUNT}`)).toBe(OTHER_COLOR)

    const drawn = appSeries(all, colors)
    expect(drawn.series).toHaveLength(SLOT_COUNT + 1)
    expect(drawn.series[SLOT_COUNT]).toMatchObject({ key: OTHER_KEY })
    expect(drawn.keyOf(`app${SLOT_COUNT + 1}`)).toBe(OTHER_KEY)
    expect(drawn.keyOf("app0")).toBe("app0")
  })

  it("lets a color chosen in Settings win, and ignores one that is not a hex color", () => {
    const colors = appColors([app("a", 1, "#112233"), app("b", 2, "red"), app("c", 3, "url(javascript:1)")])
    expect(colors.get("a")).toBe("#112233")
    expect(colors.get("b")).toBe(slotColor(1))
    expect(colors.get("c")).toBe(slotColor(2))
  })

  it("an app past the eighth with a chosen color is drawn in it, not folded", () => {
    const all = Array.from({ length: 9 }, (_, i) => app(`app${i}`, i, i === 8 ? "#abcdef" : null))
    expect(appSeries(all, appColors(all)).series.at(-1)).toMatchObject({ key: "app8", color: "#abcdef" })
  })

  it("has no Other series when every app has a color", () => {
    const all = [app("a", 1), app("b", 2)]
    expect(appSeries(all, appColors(all)).series.map((s) => s.key)).toEqual(["a", "b"])
  })
})

describe("chart data", () => {
  const range = { from: "2026-11-01", to: "2026-11-03" }
  const all = [app("a", 1), app("b", 2)]
  const drawn = appSeries(all, appColors(all))

  it("gives one value per app per bucket", () => {
    const rows = [row("a", "2026-11-01", { mrrCents: 100 }), row("b", "2026-11-01", { mrrCents: 200 }), row("a", "2026-11-03", { mrrCents: 150 })]
    const data = byApp(rows, range, "day", "mrrCents", drawn, "money")
    expect(data.points).toEqual([
      { bucket: "2026-11-01", a: 100, b: 200 },
      { bucket: "2026-11-02", a: 100, b: 200 },
      { bucket: "2026-11-03", a: 150, b: 200 },
    ])
    expect(data.series.map((s) => s.label)).toEqual(["App a", "App b"])
  })

  it("adds the apps that fold into Other", () => {
    const many = Array.from({ length: SLOT_COUNT + 2 }, (_, i) => app(`app${i}`, i))
    const series = appSeries(many, appColors(many))
    const rows = [row("app8", "2026-11-01", { installs: 3 }), row("app9", "2026-11-01", { installs: 4 }), row("app0", "2026-11-01", { installs: 1 })]
    const data = byApp(rows, { from: "2026-11-01", to: "2026-11-01" }, "day", "installs", series, "int")
    expect(data.points[0][OTHER_KEY]).toBe(7)
    expect(data.points[0].app0).toBe(1)
  })

  it("builds fixed series from several measures, with losses below zero", () => {
    const rows = [row("a", "2026-11-01", { installs: 5, uninstalls: 2 })]
    const data = totals(rows, { from: "2026-11-01", to: "2026-11-01" }, "day", INSTALLS_AND_UNINSTALLS, "int")
    expect(data.points[0]).toMatchObject({ installs: 5, uninstalls: -2 })
    expect(data.series.map((s) => s.label)).toEqual(["Installs", "Uninstalls"])
  })

  it("splits churned MRR by cause into two parts that add up to it in each bucket", () => {
    // Week of Nov 2: app a lost $9, $3 of it a store going inactive; app b lost $1 to a merchant leaving.
    // Week of Nov 9: app a lost $5, all of it a store going inactive.
    const rows = [
      row("a", "2026-11-02", { churnedMrrCents: 900, churnedMrrStoreInactiveCents: 300 }),
      row("b", "2026-11-04", { churnedMrrCents: 100 }),
      row("a", "2026-11-09", { churnedMrrCents: 500, churnedMrrStoreInactiveCents: 500 }),
    ]
    const data = totals(rows, { from: "2026-11-02", to: "2026-11-15" }, "week", CHURN_BY_CAUSE, "money")
    expect(data.points).toEqual([
      { bucket: "2026-11-02", storeInactive: 300, merchantLeft: 700 },
      { bucket: "2026-11-09", storeInactive: 500, merchantLeft: 0 },
    ])
    // Fixed hues in slot order, like MRR movement, so a cause keeps its color.
    expect(data.series).toEqual([
      { key: "storeInactive", label: "Store inactive", color: slotColor(0) },
      { key: "merchantLeft", label: "Merchant left", color: slotColor(1) },
    ])
  })

  it("lines up a comparison range bucket by bucket", () => {
    const rows = [
      row("a", "2026-10-29", { activeInstalls: 7 }),
      row("a", "2026-10-30", { activeInstalls: 8 }),
      row("a", "2026-10-31", { activeInstalls: 9 }),
      row("a", "2026-11-01", { activeInstalls: 10 }),
      row("a", "2026-11-03", { activeInstalls: 12 }),
    ]
    const data = single(rows, range, "day", { key: "active", label: "Active installs", color: slotColor(0), read: readers.activeInstalls }, "int", {
      range: { from: "2026-10-29", to: "2026-10-31" },
      label: "Previous period",
    })
    expect(data.points.map((p) => p.active)).toEqual([10, 10, 12])
    expect(data.compare).toEqual({ label: "Previous period", values: [7, 8, 9] })
  })

  it("titles buckets for tables and tooltips", () => {
    expect(bucketTitle("2026-11-16", "day")).toBe("Nov 16, 2026")
    expect(bucketTitle("2026-11-16", "week")).toBe("Week of Nov 16, 2026")
    expect(bucketTitle("2026-11-01", "month")).toBe("Nov 2026")
  })
})

describe("sparklines", () => {
  const points = bucketSeries(
    [row("a", "2026-11-01", { installs: 3, uninstalls: 1, mrrCents: 500, newMrrCents: 100, churnedMrrCents: 40, churnedMrrStoreInactiveCents: 15 })],
    { from: "2026-11-01", to: "2026-11-01" },
    "day",
  )

  it("plots a measure the KPI is built from", () => {
    expect(sparkValues(points, "installs")).toEqual([3])
    expect(sparkValues(points, "netInstalls")).toEqual([2])
    expect(sparkValues(points, "arr")).toEqual([6000])
    expect(sparkValues(points, "netNewMrr")).toEqual([60])
    expect(sparkValues(points, "churnedMrrStoreInactive")).toEqual([15])
    expect(sparkValues(points, "churnedMrrMerchantLeft")).toEqual([25])
  })

  it("has none for a ratio, which does not add up over buckets", () => {
    for (const id of ["nrr", "grr", "uninstallRate", "subChurnRate", "revenueChurnRate", "trialConversion", "feeRate", "arpu", "ltv"] as MetricId[]) {
      expect(sparkValues(points, id), id).toEqual([])
    }
  })

  it("covers every money, count and stock metric in the registry", () => {
    const ratios = new Set(["nrr", "grr", "uninstallRate", "subChurnRate", "revenueChurnRate", "trialConversion", "feeRate", "arpu", "ltv", "mrrChange"])
    const k = kpis(zero(FLOW_KEYS) as Flows, zero(STOCK_KEYS) as Stocks, zero(STOCK_KEYS) as Stocks, 30)
    for (const id of Object.keys(METRICS) as MetricId[]) {
      if (ratios.has(id)) continue
      expect(SPARK[id], `${id} should have a sparkline`).toBeTypeOf("function")
      expect(k[id as keyof typeof k], id).not.toBeUndefined()
    }
  })
})

describe("URL state", () => {
  it("sets and removes params, and resets the page number", () => {
    const next = withParams("preset=7d&page=3&q=abc", { preset: "30d", q: "" })
    expect(next.get("preset")).toBe("30d")
    expect(next.has("q")).toBe(false)
    expect(next.has("page")).toBe(false)
  })

  it("keeps the page number when the page is what is being set", () => {
    expect(withParams("q=abc", { page: "2" }).get("page")).toBe("2")
  })

  it("carries the range and comparison to another page and leaves the rest behind", () => {
    expect(carriedQuery("preset=7d&compare=previous&q=abc&page=2&apps=x")).toBe("?preset=7d&compare=previous")
    expect(carriedQuery("q=abc")).toBe("")
    expect(CARRIED_PARAMS).toContain("gran")
  })

  const today = "2026-11-22"
  const select = (query: string) => {
    const params = new URLSearchParams(query)
    return selectionFrom((name) => params.get(name), today, "2026-01-01")
  }

  it("names the preset in use", () => {
    expect(select("preset=7d")).toMatchObject({ presetKey: "7d", label: "Last 7 days", range: { from: "2026-11-16", to: today } })
  })
  it("shows a free range as dates", () => {
    expect(select("from=2026-03-01&to=2026-03-31")).toMatchObject({ presetKey: null, label: "Mar 1, 2026 to Mar 31, 2026" })
  })
  it("treats no params, and junk, as the last 30 days", () => {
    expect(select("")).toMatchObject({ presetKey: "30d", label: "Last 30 days" })
    expect(select("from=nope&to=2026-03-01")).toMatchObject({ presetKey: "30d" })
    expect(select("preset=bogus")).toMatchObject({ presetKey: "30d" })
  })
  it("shows the range the pages will actually use when the end is in the future", () => {
    expect(select("from=2026-11-01&to=2027-05-01").label).toBe("Nov 1, 2026 to Nov 22, 2026")
  })

  it("words the comparison", () => {
    expect(compareLabel("previous")).toBe("vs previous period")
    expect(compareLabel("year")).toBe("vs same period last year")
    expect(compareLabel("none")).toBe("")
  })
})

describe("a loss of nothing", () => {
  const rows = [row("a", "2026-11-01", { installs: 3 })] // no uninstalls, no churn
  const one = { from: "2026-11-01", to: "2026-11-01" }

  it("is zero, never negative zero, so it never prints as -$0", () => {
    const data = totals(rows, one, "day", INSTALLS_AND_UNINSTALLS, "int")
    expect(Object.is(data.points[0].uninstalls, 0)).toBe(true)
    const movement = totals(rows, one, "day", MRR_MOVEMENT, "money")
    for (const key of ["contraction", "churn"]) expect(Object.is(movement.points[0][key], 0), key).toBe(true)
  })
})

describe("labels", async () => {
  const { eventLabel, humanize, reasonLabel } = await import("@/lib/analytics/labels")
  const { oneOf, pageNumber, toParams } = await import("@/lib/analytics/url")

  it("makes survey words and unknown event types readable", () => {
    expect(humanize("too_expensive")).toBe("Too expensive")
    expect(humanize("  APP_NOT_WORKING ")).toBe("App not working")
    expect(reasonLabel("No reason given")).toBe("No reason given")
    expect(reasonLabel("did_not_need_it")).toBe("Did not need it")
    expect(eventLabel("SUBSCRIPTION_CREATED")).toBe("Subscribed")
    expect(eventLabel("SOMETHING_NEW_FROM_SHOPIFY")).toBe("Something new from shopify")
  })

  it("reads filters from the URL safely", () => {
    expect(pageNumber("3")).toBe(3)
    for (const bad of [undefined, "", "0", "-2", "abc", "1e9x"]) expect(pageNumber(bad), String(bad)).toBe(1)
    expect(pageNumber(["4", "5"])).toBe(4)
    expect(pageNumber("99999999")).toBe(100_000)
    expect(oneOf("paying", ["paying", "free"] as const)).toBe("paying")
    expect(oneOf("'; drop table", ["paying", "free"] as const)).toBeUndefined()
    expect(oneOf(undefined, ["paying"] as const)).toBeUndefined()
    expect(toParams({ a: "1", b: ["2", "3"], c: undefined, d: "" }).toString()).toBe("a=1&b=2")
  })
})
