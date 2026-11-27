import { describe, expect, it } from "vitest"
import { derive, type RawEvent } from "@/lib/analytics/derive"
import { movesFromPeriods, sumMoves, type MoverPeriod, type MrrMove } from "@/lib/analytics/mrr-movers"

const DAY_MS = 86_400_000
const at = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)

function ev(type: string, when: string | number, shop: string | null, over: Partial<RawEvent> = {}): RawEvent {
  return {
    type,
    occurredAt: typeof when === "number" ? new Date(when) : at(when),
    shop,
    reason: null,
    reasonDescription: null,
    planHandle: null,
    billingPeriod: null,
    trialDays: null,
    trialDaysRemaining: null,
    cancelEffectiveOn: null,
    amountCents: null,
    grossCents: null,
    netCents: null,
    feeCents: null,
    ...over,
  }
}

const NOW = at("2026-02-10")
const monthly = (amountCents: number, trialDays: number | null = null, planHandle = "pro") =>
  ({ amountCents, trialDays, planHandle, billingPeriod: "EVERY_30_DAYS" }) satisfies Partial<RawEvent>
const plan = (planHandle: string, monthlyCents: number, billingPeriod = "EVERY_30_DAYS") => ({ planHandle, billingPeriod, monthlyCents })

/** The moves of a history, in time order, as the database read hands them over. */
function movesOf(events: RawEvent[], now = NOW): MrrMove[] {
  const d = derive(events, now, "UTC")
  return movesFromPeriods("app", d.subscriptions, d.daily.at(-1)?.date ?? null, "UTC").sort(
    (a, b) => a.at.getTime() - b.at.getTime() || (a.shop < b.shop ? -1 : a.shop > b.shop ? 1 : 0) || (a.kind === "churned" ? -1 : b.kind === "churned" ? 1 : 0),
  )
}
const brief = (m: MrrMove) => ({ shop: m.shop, kind: m.kind, date: m.date, amountCents: m.amountCents })

describe("the shops behind each MRR movement", () => {
  // The history of tests/derive.test.ts:
  //   A  7-day trial on $20 from 1 Jan, converts on 8 Jan, moves to $30 on 20 Jan, cancels on 5 Feb
  //   B  cancels inside its trial: never paid
  //   C  and D  never subscribe
  //   E  $10 with no trial from 10 Jan, frozen on 15 Jan, unfrozen on 16 Jan
  const history: RawEvent[] = [
    ev("RELATIONSHIP_INSTALLED", "2026-01-01T10:00:00Z", "a.myshopify.com"),
    ev("SUBSCRIPTION_CREATED", "2026-01-01T11:00:00Z", "a.myshopify.com", monthly(2000, 7)),
    ev("CHARGE_RECURRING", "2026-01-08T11:00:00Z", "a.myshopify.com", { amountCents: 2000 }),
    ev("SUBSCRIPTION_UPDATED", "2026-01-20", "a.myshopify.com", monthly(3000)),
    ev("SUBSCRIPTION_CANCELED", "2026-02-05T09:00:00Z", "a.myshopify.com"),
    ev("RELATIONSHIP_UNINSTALLED", "2026-02-05T12:00:00Z", "a.myshopify.com", { reason: "too_expensive", reasonDescription: "Too much for us" }),
    ev("RELATIONSHIP_INSTALLED", "2026-01-02T09:00:00Z", "b.myshopify.com"),
    ev("SUBSCRIPTION_CREATED", "2026-01-02T09:30:00Z", "b.myshopify.com", { amountCents: 24000, billingPeriod: "ANNUAL", trialDays: 7, planHandle: "yearly" }),
    ev("SUBSCRIPTION_CANCELED", "2026-01-05T09:00:00Z", "b.myshopify.com"),
    ev("RELATIONSHIP_UNINSTALLED", "2026-01-05T09:05:00Z", "b.myshopify.com"),
    ev("RELATIONSHIP_INSTALLED", "2026-01-03T09:00:00Z", "c.myshopify.com"),
    ev("RELATIONSHIP_UNINSTALLED", "2026-01-04", "d.myshopify.com"),
    ev("RELATIONSHIP_INSTALLED", "2026-01-10", "e.myshopify.com"),
    ev("SUBSCRIPTION_CREATED", "2026-01-10", "e.myshopify.com", monthly(1000, null, "basic")),
    ev("SUBSCRIPTION_FROZEN", "2026-01-15", "e.myshopify.com"),
    ev("SUBSCRIPTION_UNFROZEN", "2026-01-16", "e.myshopify.com"),
  ]

  it("names every move of a history worked out by hand", () => {
    const moves = movesOf(history)
    expect(moves).toEqual([
      { appId: "app", shop: "a.myshopify.com", kind: "new", at: at("2026-01-08T11:00:00Z"), date: "2026-01-08", amountCents: 2000, before: null, after: plan("pro", 2000), via: "trial", endReason: null },
      { appId: "app", shop: "e.myshopify.com", kind: "new", at: at("2026-01-10"), date: "2026-01-10", amountCents: 1000, before: null, after: plan("basic", 1000), via: "subscription", endReason: null },
      { appId: "app", shop: "e.myshopify.com", kind: "churned", at: at("2026-01-15"), date: "2026-01-15", amountCents: 1000, before: plan("basic", 1000), after: null, via: null, endReason: "frozen" },
      { appId: "app", shop: "e.myshopify.com", kind: "new", at: at("2026-01-16"), date: "2026-01-16", amountCents: 1000, before: null, after: plan("basic", 1000), via: "resume", endReason: null },
      { appId: "app", shop: "a.myshopify.com", kind: "expansion", at: at("2026-01-20"), date: "2026-01-20", amountCents: 1000, before: plan("pro", 2000), after: plan("pro", 3000), via: null, endReason: null },
      { appId: "app", shop: "a.myshopify.com", kind: "churned", at: at("2026-02-05T09:00:00Z"), date: "2026-02-05", amountCents: 3000, before: plan("pro", 3000), after: null, via: null, endReason: "canceled" },
    ])
    expect(sumMoves(moves)).toEqual({ newMrrCents: 4000, expansionMrrCents: 1000, contractionMrrCents: 0, churnedMrrCents: 4000, netNewMrrCents: 1000, newSubs: 3, canceledSubs: 2 })
  })

  it("gives the same moves whatever order the periods come in", () => {
    const d = derive(history, NOW, "UTC")
    const key = (m: MrrMove) => `${m.at.toISOString()} ${m.shop} ${m.kind} ${m.amountCents}`
    const forward = movesFromPeriods("app", d.subscriptions, "2026-02-10", "UTC").map(key).sort()
    const backward = movesFromPeriods("app", [...d.subscriptions].reverse(), "2026-02-10", "UTC").map(key).sort()
    expect(backward).toEqual(forward)
  })

  it("books a downgrade as contraction, with both prices", () => {
    const moves = movesOf([
      ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(3000, null, "plus")),
      ev("SUBSCRIPTION_UPDATED", "2026-01-10", "x.myshopify.com", monthly(1000, null, "basic")),
    ])
    expect(moves.map(brief)).toEqual([
      { shop: "x.myshopify.com", kind: "new", date: "2026-01-01", amountCents: 3000 },
      { shop: "x.myshopify.com", kind: "contraction", date: "2026-01-10", amountCents: 2000 },
    ])
    expect(moves[1]).toMatchObject({ before: plan("plus", 3000), after: plan("basic", 1000) })
  })

  it("books a move to a free plan as churn, and the move back as new revenue through a plan change", () => {
    const moves = movesOf([
      ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(2000)),
      ev("SUBSCRIPTION_UPDATED", "2026-01-10", "x.myshopify.com", monthly(0, null, "free")),
      ev("SUBSCRIPTION_UPDATED", "2026-01-20", "x.myshopify.com", monthly(2000)),
    ])
    expect(moves.map(brief)).toEqual([
      { shop: "x.myshopify.com", kind: "new", date: "2026-01-01", amountCents: 2000 },
      { shop: "x.myshopify.com", kind: "churned", date: "2026-01-10", amountCents: 2000 },
      { shop: "x.myshopify.com", kind: "new", date: "2026-01-20", amountCents: 2000 },
    ])
    expect(moves[1]).toMatchObject({ endReason: "replaced", before: plan("pro", 2000), after: plan("free", 0) })
    expect(moves[2]).toMatchObject({ via: "plan_change", before: plan("free", 0), after: plan("pro", 2000) })
  })

  it("reads 'new plan created, old plan canceled' as one upgrade", () => {
    const moves = movesOf([
      ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(1000, null, "basic")),
      ev("SUBSCRIPTION_CREATED", "2026-01-10T10:00:00Z", "x.myshopify.com", monthly(3000, null, "plus")),
      ev("SUBSCRIPTION_CANCELED", "2026-01-10T10:01:00Z", "x.myshopify.com", monthly(1000, null, "basic")),
    ])
    expect(moves.map(brief)).toEqual([
      { shop: "x.myshopify.com", kind: "new", date: "2026-01-01", amountCents: 1000 },
      { shop: "x.myshopify.com", kind: "expansion", date: "2026-01-10", amountCents: 2000 },
    ])
  })

  it("counts a cancel on the day it takes effect", () => {
    const moves = movesOf([
      ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(2000)),
      ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-10", "x.myshopify.com", { cancelEffectiveOn: at("2026-01-31") }),
    ])
    expect(moves.at(-1)).toMatchObject({ kind: "churned", date: "2026-01-31", amountCents: 2000, endReason: "canceled", at: new Date("2026-01-31T00:00:00Z") })
  })

  it("leaves a scheduled cancellation that has not taken effect out", () => {
    const moves = movesOf([
      ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(2000)),
      ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-02-01", "x.myshopify.com", { cancelEffectiveOn: at("2026-03-01") }),
    ])
    expect(moves.map((m) => m.kind)).toEqual(["new"])
  })

  it("treats a paying shop that moves to a plan with a new trial as churn, then new revenue when the trial converts", () => {
    const moves = movesOf([
      ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(1000, null, "basic")),
      ev("SUBSCRIPTION_CREATED", "2026-01-10", "x.myshopify.com", monthly(3000, 7, "plus")),
    ])
    expect(moves.map(brief)).toEqual([
      { shop: "x.myshopify.com", kind: "new", date: "2026-01-01", amountCents: 1000 },
      { shop: "x.myshopify.com", kind: "churned", date: "2026-01-10", amountCents: 1000 },
      { shop: "x.myshopify.com", kind: "new", date: "2026-01-17", amountCents: 3000 },
    ])
    expect(moves[1]).toMatchObject({ endReason: "replaced", after: plan("plus", 3000) })
    expect(moves[2]).toMatchObject({ via: "trial" })
  })

  it("dates a move after the last rebuild on the rollup's last day, as the rollup does", () => {
    const events = [ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(2000)), ev("SUBSCRIPTION_CANCELED", "2026-03-01", "x.myshopify.com")]
    const moves = movesOf(events)
    expect(moves[1]).toMatchObject({ kind: "churned", date: "2026-02-10", at: at("2026-03-01") })
    expect(derive(events, NOW, "UTC").daily.at(-1)).toMatchObject({ date: "2026-02-10", churnedMrrCents: 2000 })
  })

  it("adds up to the daily rollup on every day of generated histories", () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= 300; seed++) {
      const now = new Date(Date.UTC(2026, 3, 1, 15))
      const events = randomHistory(seed, now)
      const d = derive(events, now, "UTC")
      const periods = shuffle(d.subscriptions, seed)
      const moves = movesFromPeriods("app", periods, d.daily.at(-1)?.date ?? null, "UTC")

      const byDay = new Map<string, MrrMove[]>()
      const days = new Set(d.daily.map((r) => r.date))
      for (const m of moves) {
        expect(days.has(m.date), `seed ${seed}: ${m.date} is outside the rollup`).toBe(true)
        byDay.set(m.date, [...(byDay.get(m.date) ?? []), m])
        seen.add(m.kind === "new" ? `new ${m.via}` : m.kind === "churned" ? `churned ${m.endReason}` : m.kind)
        if (m.at.getTime() > now.getTime()) seen.add("after now")
      }
      for (const row of d.daily) {
        const t = sumMoves(byDay.get(row.date) ?? [])
        expect(
          { newMrr: t.newMrrCents, expansion: t.expansionMrrCents, contraction: t.contractionMrrCents, churned: t.churnedMrrCents, newSubs: t.newSubs, canceledSubs: t.canceledSubs },
          `seed ${seed}, ${row.date}`,
        ).toEqual({
          newMrr: row.newMrrCents,
          expansion: row.expansionMrrCents,
          contraction: row.contractionMrrCents,
          churned: row.churnedMrrCents,
          newSubs: row.newSubs,
          canceledSubs: row.canceledSubs,
        })
      }
    }
    // The generator reaches every kind of move, so the comparison above is not empty.
    for (const kind of [
      "new subscription", "new trial", "new resume", "new plan_change", "expansion", "contraction",
      "churned canceled", "churned uninstalled", "churned frozen", "churned replaced", "after now",
    ]) {
      expect(seen.has(kind), kind).toBe(true)
    }
  })
})

/** mulberry32, so a failing seed can be run again. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(list: MoverPeriod[], seed: number): MoverPeriod[] {
  const rand = random(seed * 7919)
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Shops doing everything Shopify can report, in any order: events on the same instant, minutes
 * apart (inside the plan change window) and days apart, prices and plans that change or are
 * missing, trials, cancels that take effect later, freezes, and events dated after now.
 */
function randomHistory(seed: number, now: Date): RawEvent[] {
  const rand = random(seed)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]
  const types = [
    "RELATIONSHIP_INSTALLED", "RELATIONSHIP_UNINSTALLED",
    "SUBSCRIPTION_CREATED", "SUBSCRIPTION_CREATED", "SUBSCRIPTION_CREATED", "SUBSCRIPTION_UPDATED", "SUBSCRIPTION_UPDATED",
    "SUBSCRIPTION_CANCELED", "SUBSCRIPTION_CANCELED", "SUBSCRIPTION_CANCELLATION_SCHEDULED",
    "SUBSCRIPTION_FROZEN", "SUBSCRIPTION_UNFROZEN", "CHARGE_RECURRING", "RELATIONSHIP_DEACTIVATED",
  ] as const
  const planFields = (): Partial<RawEvent> => ({
    amountCents: pick([null, 0, 500, 1000, 2000, 2000, 3000, 24000]),
    billingPeriod: pick([null, "EVERY_30_DAYS", "EVERY_30_DAYS", "ANNUAL"]),
    planHandle: pick([null, "basic", "pro", "plus", "free"]),
    trialDays: pick([null, null, 0, 7, 14]),
    trialDaysRemaining: pick([null, null, null, 0, 3, 10]),
  })
  const dayAfter = (t: number, days: number) => new Date(Math.floor(t / DAY_MS) * DAY_MS + days * DAY_MS)

  const events: RawEvent[] = []
  const start = now.getTime() - 90 * DAY_MS
  for (let s = 0; s < 25; s++) {
    const shop = `shop-${s}.myshopify.com`
    let t = start + Math.floor(rand() * 30 * DAY_MS)
    const count = 2 + Math.floor(rand() * 16)
    for (let k = 0; k < count; k++) {
      const step = rand()
      t += step < 0.15 ? 0 : step < 0.35 ? Math.floor(rand() * 12) * 60_000 : Math.floor(rand() * 12 * DAY_MS)
      const type = k === 0 ? "RELATIONSHIP_INSTALLED" : pick(types)
      let over: Partial<RawEvent> = {}
      if (type === "SUBSCRIPTION_CREATED" || type === "SUBSCRIPTION_UPDATED") over = planFields()
      else if (type === "SUBSCRIPTION_CANCELED") over = { ...(rand() < 0.4 ? planFields() : {}), cancelEffectiveOn: rand() < 0.3 ? dayAfter(t, Math.floor(rand() * 20) - 2) : null }
      else if (type === "SUBSCRIPTION_CANCELLATION_SCHEDULED") over = { cancelEffectiveOn: rand() < 0.85 ? dayAfter(t, Math.floor(rand() * 25) - 2) : null }
      else if (type === "CHARGE_RECURRING") over = { amountCents: pick([0, 1000, 2000]) }
      events.push(ev(type, t, shop, over))
    }
  }
  events.push(ev("CHARGE_ONE_TIME", start, null, { amountCents: 500 }))
  return events
}
