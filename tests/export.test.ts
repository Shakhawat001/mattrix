import { describe, expect, it } from "vitest"
import { FLOW_KEYS, STOCK_KEYS, type DayRow, type Flows, type Stocks } from "@/lib/analytics/aggregate"
import { dailyRows, eventRows, shopRows } from "@/lib/analytics/export"
import type { EventRow, ShopRow } from "@/lib/analytics/queries"
import { toCsv } from "@/lib/csv"
import { formatAgo } from "@/lib/format"

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>
const row = (appId: string, date: string, over: Partial<Flows & Stocks> = {}): DayRow => ({ appId, date, ...zero(FLOW_KEYS), ...zero(STOCK_KEYS), ...over })
const labelOf = (id: string) => ({ a: "Badge Pro", b: "Cart Notes" })[id] ?? "?"

describe("daily export", () => {
  const range = { from: "2026-11-02", to: "2026-11-03" }
  const rows = [
    row("b", "2026-11-03", { installs: 1 }),
    row("a", "2026-11-03", { installs: 2, mrrCents: 1999, newMrrCents: 500 }),
    row("a", "2026-11-02", { installs: 3 }),
    row("a", "2026-11-01", { installs: 99 }), // the day before the range: only there to give the starting stocks
  ]
  const out = dailyRows(rows, labelOf, range)
  const header = out[0] as string[]

  it("names money columns in dollars and everything else plainly, in snake case", () => {
    expect(header.slice(0, 5)).toEqual(["date", "app", "installs", "reinstalls", "uninstalls"])
    expect(header).toContain("new_mrr_usd")
    expect(header).toContain("mrr_usd")
    expect(header).toContain("active_installs")
    expect(header.some((h) => h.endsWith("cents"))).toBe(false)
  })
  it("writes money as dollars", () => {
    const line = out.find((r) => r[0] === "2026-11-03" && r[1] === "Badge Pro")!
    expect(line[header.indexOf("mrr_usd")]).toBe(19.99)
    expect(line[header.indexOf("new_mrr_usd")]).toBe(5)
    expect(line[header.indexOf("installs")]).toBe(2)
  })
  it("sorts by date, then app, and leaves out days outside the range", () => {
    expect(out.slice(1).map((r) => [r[0], r[1]])).toEqual([["2026-11-02", "Badge Pro"], ["2026-11-03", "Badge Pro"], ["2026-11-03", "Cart Notes"]])
  })
})

describe("shop and event exports", () => {
  const shop: ShopRow = {
    appId: "a", shop: "=cmd|' /C calc'!A0.myshopify.com", installed: false, installs: 2, firstInstalledAt: new Date("2026-01-01T10:00:00Z"),
    lastInstalledAt: new Date("2026-02-01T10:00:00Z"), uninstalledAt: new Date("2026-03-01T10:00:00Z"), reason: "too_expensive, other",
    planHandle: "pro", billingPeriod: "ANNUAL", monthlyCents: 2000, subscribed: false, inTrial: false, charged: 4500,
  }
  const event: EventRow = {
    id: "e1", appId: "a", type: "RELATIONSHIP_UNINSTALLED", occurredAt: new Date("2026-03-01T10:00:00Z"), shop: "a.myshopify.com", state: null,
    reason: "too_expensive", reasonDescription: "+1 formula, \"quoted\", and a\nnew line", planHandle: null, billingPeriod: null, amountCents: null, netCents: null, feeCents: null,
  }

  it("defuses spreadsheet formulas in text that came from outside, once written", () => {
    const text = toCsv(shopRows([shop], labelOf))
    expect(text).toContain("'=cmd|")
    expect(text).not.toMatch(/\r\n=cmd/)
    const events = toCsv(eventRows([event], labelOf))
    expect(events).toContain("\"'+1 formula, \"\"quoted\"\", and a\nnew line\"")
  })
  it("reports an unsubscribed shop as having no plan and no MRR", () => {
    const [, line] = shopRows([shop], labelOf)
    expect(line.slice(2, 7)).toEqual(["uninstalled", "", "", false, 0])
    expect(line[7]).toBe(45)
  })
  it("gives the readable event name and the raw type", () => {
    const [header, line] = eventRows([event], labelOf)
    expect(line[(header as string[]).indexOf("event")]).toBe("Uninstalled")
    expect(line[(header as string[]).indexOf("event_type")]).toBe("RELATIONSHIP_UNINSTALLED")
  })
})

describe("how old the last sync is", () => {
  const now = new Date("2026-11-22T12:00:00Z")
  const ago = (seconds: number) => formatAgo(new Date(now.getTime() - seconds * 1000), now)
  it("speaks in the unit that fits", () => {
    expect(ago(10)).toBe("just now")
    expect(ago(60)).toBe("a minute ago")
    expect(ago(12 * 60)).toBe("12 minutes ago")
    expect(ago(60 * 60)).toBe("an hour ago")
    expect(ago(5 * 3600)).toBe("5 hours ago")
    expect(ago(3 * 86400)).toBe("3 days ago")
  })
  it("treats a time in the future as just now", () => {
    expect(formatAgo(new Date(now.getTime() + 5000), now)).toBe("just now")
  })
})
