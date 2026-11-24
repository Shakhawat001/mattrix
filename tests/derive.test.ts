import { describe, expect, it } from "vitest"
import { DERIVE_VERSION, derive, monthlyCents, type DailyRow, type RawEvent } from "@/lib/analytics/derive"
import { LEGACY_EVENT_TYPES } from "@/lib/partner/query"

const at = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)

function ev(type: string, when: string, shop: string | null, over: Partial<RawEvent> = {}): RawEvent {
  return {
    type,
    occurredAt: at(when),
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
const dayOf = (r: ReturnType<typeof derive>, date: string) => r.daily.find((d) => d.date === date)!
const mrrAddsUp = (r: ReturnType<typeof derive>) => {
  for (let i = 1; i < r.daily.length; i++) {
    const [prev, d] = [r.daily[i - 1], r.daily[i]]
    expect(d.mrrCents, d.date).toBe(prev.mrrCents + d.newMrrCents + d.expansionMrrCents - d.contractionMrrCents - d.churnedMrrCents)
  }
}

// A small history with every kind of thing in it. Day 0 is 2026-01-01.
//   A  installs, 7-day trial on $20, which converts on 8 Jan, upgrades to $30 on 20 Jan, cancels and uninstalls on 5 Feb
//   B  installs, trial on a $240 a year plan, cancels inside the trial on 5 Jan: never paid
//   C  installs and uninstalls the same day, comes back on 12 Jan and stays
//   D  an uninstall whose install was never seen
//   E  installs, $10 plan with no trial, frozen on 15 Jan, unfrozen on 16 Jan
const history: RawEvent[] = [
  ev("RELATIONSHIP_INSTALLED", "2026-01-01T10:00:00Z", "a.myshopify.com"),
  ev("SUBSCRIPTION_CREATED", "2026-01-01T11:00:00Z", "a.myshopify.com", monthly(2000, 7)),
  ev("CHARGE_RECURRING", "2026-01-08T11:00:00Z", "a.myshopify.com", { amountCents: 2000 }),
  ev("EARNING_CHARGE_RECURRING", "2026-01-11", "a.myshopify.com", { grossCents: 2000, netCents: 1700, feeCents: 300 }),
  ev("SUBSCRIPTION_UPDATED", "2026-01-20", "a.myshopify.com", monthly(3000)),
  ev("EARNING_REFUND", "2026-01-25", "a.myshopify.com", { grossCents: -500, netCents: -425, feeCents: -75 }),
  ev("CREDIT_APPLIED", "2026-01-26", "a.myshopify.com", { amountCents: 300 }),
  ev("SUBSCRIPTION_CANCELED", "2026-02-05T09:00:00Z", "a.myshopify.com"),
  ev("RELATIONSHIP_UNINSTALLED", "2026-02-05T12:00:00Z", "a.myshopify.com", { reason: "too_expensive", reasonDescription: "Too much for us" }),

  ev("RELATIONSHIP_INSTALLED", "2026-01-02T09:00:00Z", "b.myshopify.com"),
  ev("SUBSCRIPTION_CREATED", "2026-01-02T09:30:00Z", "b.myshopify.com", { amountCents: 24000, billingPeriod: "ANNUAL", trialDays: 7, planHandle: "yearly" }),
  ev("SUBSCRIPTION_CANCELED", "2026-01-05T09:00:00Z", "b.myshopify.com"),
  ev("RELATIONSHIP_UNINSTALLED", "2026-01-05T09:05:00Z", "b.myshopify.com"),

  ev("RELATIONSHIP_INSTALLED", "2026-01-03T09:00:00Z", "c.myshopify.com"),
  ev("RELATIONSHIP_UNINSTALLED", "2026-01-03T15:00:00Z", "c.myshopify.com"),
  ev("RELATIONSHIP_INSTALLED", "2026-01-12", "c.myshopify.com"),

  ev("RELATIONSHIP_UNINSTALLED", "2026-01-04", "d.myshopify.com"),

  ev("RELATIONSHIP_INSTALLED", "2026-01-10", "e.myshopify.com"),
  ev("SUBSCRIPTION_CREATED", "2026-01-10", "e.myshopify.com", monthly(1000, null, "basic")),
  ev("SUBSCRIPTION_FROZEN", "2026-01-15", "e.myshopify.com"),
  ev("SUBSCRIPTION_UNFROZEN", "2026-01-16", "e.myshopify.com"),
]

const result = derive(history, NOW)
const day = (date: string): DailyRow => dayOf(result, date)

describe("DERIVE_VERSION", () => {
  it("is a whole number above 0, which marks apps built before versions were kept", () => {
    expect(Number.isInteger(DERIVE_VERSION)).toBe(true)
    expect(DERIVE_VERSION).toBeGreaterThan(0)
  })
})

describe("monthlyCents", () => {
  it("spreads a yearly price over twelve months and leaves others alone", () => {
    expect(monthlyCents(24000, "ANNUAL")).toBe(2000)
    expect(monthlyCents(9900, "ANNUAL")).toBe(825)
    expect(monthlyCents(2499, "EVERY_30_DAYS")).toBe(2499)
    expect(monthlyCents(2499, null)).toBe(2499)
    expect(monthlyCents(null, "ANNUAL")).toBeNull()
  })
})

describe("installs", () => {
  it("makes one stay per install, and numbers a shop's returns", () => {
    expect(result.installs).toHaveLength(5)
    const c = result.installs.filter((i) => i.shop === "c.myshopify.com")
    expect(c.map((i) => i.seq)).toEqual([1, 2])
    expect(c[0].uninstalledAt).not.toBeNull()
    expect(c[1].uninstalledAt).toBeNull()
  })

  it("keeps the reason and the merchant's own words on the stay that ended", () => {
    const a = result.installs.find((i) => i.shop === "a.myshopify.com")!
    expect(a.reason).toBe("too_expensive")
    expect(a.reasonDescription).toBe("Too much for us")
    expect(a.uninstalledAt?.toISOString()).toBe("2026-02-05T12:00:00.000Z")
  })

  it("counts an uninstall whose install it never saw, but gives it no stay", () => {
    expect(result.orphanUninstalls).toBe(1)
    expect(result.installs.some((i) => i.shop === "d.myshopify.com")).toBe(false)
  })

  it("ignores a second install event while one stay is open", () => {
    const r = derive([ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"), ev("RELATIONSHIP_INSTALLED", "2026-01-02", "x.myshopify.com")], NOW)
    expect(r.installs).toHaveLength(1)
  })
})

describe("subscriptions", () => {
  const periods = (shop: string, r = result) => r.subscriptions.filter((s) => s.shop === shop).sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime())

  it("starts a new period at a plan change and carries the old price along", () => {
    const [first, second] = periods("a.myshopify.com")
    expect(first).toMatchObject({ kind: "new", monthlyCents: 2000, endReason: "replaced", planHandle: "pro" })
    expect(second).toMatchObject({ kind: "change", monthlyCents: 3000, previousMonthlyCents: 2000, endReason: "canceled" })
  })

  it("normalizes a yearly plan to a monthly value", () => {
    expect(periods("b.myshopify.com")[0]).toMatchObject({ monthlyCents: 2000, billingPeriod: "ANNUAL", planHandle: "yearly" })
  })

  it("ends a frozen period and resumes it at the same price and plan", () => {
    const [frozen, resumed] = periods("e.myshopify.com")
    expect(frozen).toMatchObject({ endReason: "frozen", monthlyCents: 1000 })
    expect(resumed).toMatchObject({ kind: "resume", monthlyCents: 1000, planHandle: "basic", endedAt: null })
  })

  it("records the trial's end and conversion on the period that began it, not on later ones", () => {
    const [first, afterwards] = periods("a.myshopify.com")
    expect(first.trialEndsAt?.toISOString()).toBe("2026-01-08T11:00:00.000Z")
    expect(first.convertedAt?.toISOString()).toBe("2026-01-08T11:00:00.000Z")
    // The trial was over before the plan change, so the new period has none.
    expect(afterwards.trialEndsAt).toBeNull()
    expect(afterwards.convertedAt).toBeNull()
    expect(periods("b.myshopify.com")[0].convertedAt).toBeNull()
  })

  it("does not open a new period for an update that keeps the same plan and price", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(1000)),
        ev("SUBSCRIPTION_UPDATED", "2026-01-05", "x.myshopify.com", monthly(1000)),
      ],
      NOW,
    )
    expect(r.subscriptions).toHaveLength(1)
  })

  it("shares one trial between the periods of a plan change made during it", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(1000, 14)),
        ev("SUBSCRIPTION_UPDATED", "2026-01-05", "x.myshopify.com", monthly(2000)),
      ],
      NOW,
    )
    const [first, second] = periods("x.myshopify.com", r)
    expect(first.convertedAt?.toISOString()).toBe("2026-01-15T12:00:00.000Z")
    expect(second.convertedAt?.toISOString()).toBe("2026-01-15T12:00:00.000Z")
    expect(r.trials).toHaveLength(1)
    // Paying starts when the trial ends, at the price in force then.
    expect(dayOf(r, "2026-01-15")).toMatchObject({ activeSubs: 1, mrrCents: 2000, newMrrCents: 2000, trialSubs: 0 })
    expect(dayOf(r, "2026-01-14")).toMatchObject({ activeSubs: 0, mrrCents: 0, trialSubs: 1, trialMrrCents: 2000 })
    mrrAddsUp(r)
  })
})

describe("trials", () => {
  it("records what became of each", () => {
    expect(result.trials).toHaveLength(2)
    const a = result.trials.find((t) => t.shop === "a.myshopify.com")!
    const b = result.trials.find((t) => t.shop === "b.myshopify.com")!
    expect(a).toMatchObject({ outcome: "converted", trialDays: 7 })
    expect(a.resolvedAt?.toISOString()).toBe("2026-01-08T11:00:00.000Z")
    expect(b.outcome).toBe("canceled")
    expect(b.resolvedAt?.toISOString()).toBe("2026-01-05T09:00:00.000Z")
  })

  it("converts a trial when it ends with the subscription open, without waiting for a charge", () => {
    const base = [ev("RELATIONSHIP_INSTALLED", "2026-02-01", "x.myshopify.com"), ev("SUBSCRIPTION_CREATED", "2026-02-08", "x.myshopify.com", monthly(2000, 7))]
    expect(derive(base, NOW).trials[0].outcome).toBe("open")
    const later = derive(base, at("2026-03-01"))
    expect(later.trials[0]).toMatchObject({ outcome: "converted" })
    expect(later.trials[0].resolvedAt?.toISOString()).toBe("2026-02-15T12:00:00.000Z")
  })

  it("converts early on a real charge before the trial's end, but not on a $0 one", () => {
    const events = (amount: number) => [
      ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
      ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(2000, 14)),
      ev("CHARGE_RECURRING", "2026-01-05", "x.myshopify.com", { amountCents: amount }),
    ]
    expect(derive(events(2000), NOW).trials[0].resolvedAt?.toISOString()).toBe("2026-01-05T12:00:00.000Z")
    // A $0 charge changes nothing: it converts at the trial's end on 15 Jan.
    expect(derive(events(0), NOW).trials[0].resolvedAt?.toISOString()).toBe("2026-01-15T12:00:00.000Z")
  })

  it("uses the trial days the merchant actually has left, not the plan's full trial", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", { ...monthly(2000, 14), trialDaysRemaining: 3 }),
      ],
      NOW,
    )
    expect(r.trials[0]).toMatchObject({ trialDays: 3, outcome: "converted" })
    expect(r.trials[0].endsAt.toISOString()).toBe("2026-01-04T12:00:00.000Z")
  })

  it("gives no trial to a merchant with none left: they pay from the first day", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", { ...monthly(2000, 14), trialDaysRemaining: 0 }),
      ],
      NOW,
    )
    expect(r.trials).toHaveLength(0)
    expect(r.daily[0]).toMatchObject({ activeSubs: 1, mrrCents: 2000, newSubs: 1 })
  })

  it("converts at once when a trial moves to a plan with no trial days left", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(1000, 14)),
        ev("SUBSCRIPTION_UPDATED", "2026-01-05", "x.myshopify.com", { ...monthly(3000, null, "plus"), trialDaysRemaining: 0 }),
      ],
      NOW,
    )
    expect(r.trials[0].outcome).toBe("converted")
    expect(dayOf(r, "2026-01-05")).toMatchObject({ newMrrCents: 3000, newSubs: 1, activeSubs: 1, mrrCents: 3000, trialSubs: 0 })
    mrrAddsUp(r)
  })
})

describe("daily rollup", () => {
  it("has one row per day from the first event to today", () => {
    expect(result.daily).toHaveLength(41)
    expect(result.daily[0].date).toBe("2026-01-01")
    expect(result.daily[40].date).toBe("2026-02-10")
  })

  it("counts a trial apart from paying subscribers on the day it starts", () => {
    expect(day("2026-01-01")).toMatchObject({
      installs: 1, trialsStarted: 1, newSubs: 0, newMrrCents: 0,
      activeInstalls: 1, activeSubs: 0, mrrCents: 0, trialSubs: 1, trialMrrCents: 2000,
    })
  })

  it("values a trial on a yearly plan at a twelfth of its price", () => {
    expect(day("2026-01-02")).toMatchObject({ installs: 1, activeInstalls: 2, activeSubs: 0, trialSubs: 2, trialMrrCents: 4000 })
  })

  it("nets an install and an uninstall on the same day to nothing in the stock", () => {
    expect(day("2026-01-03")).toMatchObject({ installs: 1, uninstalls: 1, activeInstalls: 2 })
  })

  it("counts an orphan uninstall as a flow but not against the stock", () => {
    expect(day("2026-01-04")).toMatchObject({ uninstalls: 1, activeInstalls: 2 })
  })

  it("counts a cancel inside a trial as a canceled trial, not as churn", () => {
    expect(day("2026-01-05")).toMatchObject({
      trialsCanceled: 1, canceledSubs: 0, churnedMrrCents: 0, uninstalls: 1, activeInstalls: 1, activeSubs: 0, trialSubs: 1, trialMrrCents: 2000,
    })
  })

  it("turns a trial into a paying subscriber, and new MRR, on the day it converts", () => {
    expect(day("2026-01-08")).toMatchObject({ trialsConverted: 1, newSubs: 1, newMrrCents: 2000, chargedCents: 2000, activeSubs: 1, mrrCents: 2000, trialSubs: 0 })
  })

  it("counts a subscription with no trial as paying from its first day", () => {
    expect(day("2026-01-10")).toMatchObject({ installs: 1, newSubs: 1, newMrrCents: 1000, activeInstalls: 2, activeSubs: 2, mrrCents: 3000 })
  })

  it("counts a return as a reinstall and as an install", () => {
    expect(day("2026-01-12")).toMatchObject({ installs: 1, reinstalls: 1, activeInstalls: 3 })
  })

  it("treats a freeze as lost revenue and an unfreeze as revenue regained", () => {
    expect(day("2026-01-15")).toMatchObject({ churnedMrrCents: 1000, canceledSubs: 1, churnedMrrStoreInactiveCents: 1000, canceledSubsStoreInactive: 1, activeSubs: 1, mrrCents: 2000 })
    expect(day("2026-01-16")).toMatchObject({ newMrrCents: 1000, newSubs: 1, activeSubs: 2, mrrCents: 3000 })
  })

  it("books a plan change as expansion, not as churn plus new", () => {
    expect(day("2026-01-20")).toMatchObject({ expansionMrrCents: 1000, contractionMrrCents: 0, churnedMrrCents: 0, newMrrCents: 0, mrrCents: 4000, activeSubs: 2 })
  })

  it("keeps payouts, refunds and credits apart from charges", () => {
    expect(day("2026-01-11")).toMatchObject({ grossEarnedCents: 2000, netEarnedCents: 1700, feeCents: 300, chargedCents: 0 })
    expect(day("2026-01-25")).toMatchObject({ refundedCents: 500, grossEarnedCents: -500, netEarnedCents: -425, feeCents: -75 })
    expect(day("2026-01-26")).toMatchObject({ creditCents: 300 })
  })

  it("books a cancel and an uninstall on the last day as churn, once", () => {
    expect(day("2026-02-05")).toMatchObject({ churnedMrrCents: 3000, canceledSubs: 1, uninstalls: 1, activeInstalls: 2, activeSubs: 1, mrrCents: 1000 })
    // The store was never deactivated: the merchant left.
    expect(day("2026-02-05")).toMatchObject({ churnedMrrStoreInactiveCents: 0, canceledSubsStoreInactive: 0, uninstallsStoreInactive: 0 })
  })

  it("ends on the right stocks", () => {
    expect(day("2026-02-10")).toMatchObject({ activeInstalls: 2, activeSubs: 1, trialSubs: 0, mrrCents: 1000, trialMrrCents: 0 })
  })

  it("never lets a stock go negative", () => {
    for (const d of result.daily) {
      for (const key of ["activeInstalls", "activeSubs", "trialSubs", "mrrCents", "trialMrrCents"] as const) {
        expect(d[key], `${d.date} ${key}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it("adds up: every day's MRR is last day's plus new and expansion, minus contraction and churn", () => {
    mrrAddsUp(result)
  })
})

describe("cancellations that take effect later", () => {
  const sub = [ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"), ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(2000))]

  it("keeps a scheduled cancellation paying until its date, then counts the churn on that day", () => {
    const r = derive([...sub, ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-10", "x.myshopify.com", { cancelEffectiveOn: at("2026-01-31") })], NOW)
    expect(dayOf(r, "2026-01-30")).toMatchObject({ activeSubs: 1, mrrCents: 2000, churnedMrrCents: 0 })
    expect(dayOf(r, "2026-01-31")).toMatchObject({ activeSubs: 0, mrrCents: 0, churnedMrrCents: 2000, canceledSubs: 1 })
    expect(r.subscriptions[0]).toMatchObject({ endReason: "canceled" })
    expect(r.subscriptions[0].endedAt?.toISOString()).toBe("2026-01-31T00:00:00.000Z")
    mrrAddsUp(r)
  })

  it("does the same for a cancel that says it takes effect later", () => {
    const r = derive([...sub, ev("SUBSCRIPTION_CANCELED", "2026-01-10", "x.myshopify.com", { cancelEffectiveOn: at("2026-01-25") })], NOW)
    expect(dayOf(r, "2026-01-10")).toMatchObject({ churnedMrrCents: 0, activeSubs: 1 })
    expect(dayOf(r, "2026-01-25")).toMatchObject({ churnedMrrCents: 2000, activeSubs: 0 })
  })

  it("still counts as paying today when the date has not come yet", () => {
    const r = derive([...sub, ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-02-01", "x.myshopify.com", { cancelEffectiveOn: at("2026-03-01") })], NOW)
    expect(r.daily.at(-1)).toMatchObject({ activeSubs: 1, mrrCents: 2000 })
    expect(r.subscriptions[0].endedAt).toBeNull()
  })

  it("forgets a scheduled cancellation when the shop moves to another plan before it", () => {
    const r = derive(
      [
        ...sub,
        ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-10", "x.myshopify.com", { cancelEffectiveOn: at("2026-01-31") }),
        ev("SUBSCRIPTION_UPDATED", "2026-01-20", "x.myshopify.com", monthly(3000, null, "plus")),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-31")).toMatchObject({ churnedMrrCents: 0, activeSubs: 1, mrrCents: 3000 })
  })

  it("counts a trial whose cancellation takes effect before it ends as a canceled trial, never paid", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(2000, 14)),
        ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-03", "x.myshopify.com", { cancelEffectiveOn: at("2026-01-10") }),
      ],
      NOW,
    )
    expect(r.trials[0].outcome).toBe("canceled")
    expect(r.daily.every((d) => d.mrrCents === 0 && d.churnedMrrCents === 0)).toBe(true)
  })

  /** The start of a UTC day: when a cancel that takes effect that day ends the period. */
  const startOf = (day: string) => new Date(`${day}T00:00:00Z`)

  it("keeps on the period when the cancel was scheduled and the day it takes effect", () => {
    // Scheduled on 10 January for 31 January: the period ends at the start of that day.
    const ended = derive([...sub, ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-10", "x.myshopify.com", { cancelEffectiveOn: at("2026-01-31") })], NOW)
    expect(ended.subscriptions).toMatchObject([{ endReason: "canceled", endedAt: startOf("2026-01-31"), cancelScheduledAt: at("2026-01-10"), cancelEffectiveAt: startOf("2026-01-31") }])

    // A cancel sent on 1 February that takes effect on 1 March: on 10 February the period is open and set to end.
    const pending = derive([...sub, ev("SUBSCRIPTION_CANCELED", "2026-02-01", "x.myshopify.com", { cancelEffectiveOn: at("2026-03-01") })], NOW)
    expect(pending.subscriptions).toMatchObject([{ endReason: null, endedAt: null, cancelScheduledAt: at("2026-02-01"), cancelEffectiveAt: startOf("2026-03-01") }])
  })

  it("moves the day when Shopify schedules the cancel again, and keeps when it was first scheduled", () => {
    // Scheduled on 10 January for 31 January, then on 20 January for 28 February.
    const r = derive(
      [
        ...sub,
        ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-10", "x.myshopify.com", { cancelEffectiveOn: at("2026-01-31") }),
        ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-20", "x.myshopify.com", { cancelEffectiveOn: at("2026-02-28") }),
      ],
      NOW,
    )
    expect(r.subscriptions).toMatchObject([{ endedAt: null, cancelScheduledAt: at("2026-01-10"), cancelEffectiveAt: startOf("2026-02-28") }])
    expect(dayOf(r, "2026-01-31")).toMatchObject({ churnedMrrCents: 0, activeSubs: 1, mrrCents: 2000 })
    mrrAddsUp(r)
  })

  it("keeps no scheduled end for a cancel that takes effect at once, nor on the plan the shop moves to", () => {
    const atOnce = derive([...sub, ev("SUBSCRIPTION_CANCELED", "2026-01-10", "x.myshopify.com")], NOW)
    expect(atOnce.subscriptions).toMatchObject([{ endReason: "canceled", endedAt: at("2026-01-10"), cancelScheduledAt: null, cancelEffectiveAt: null }])
    // Scheduled for the day it is sent: it takes effect at once.
    const sameDay = derive([...sub, ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-10", "x.myshopify.com", { cancelEffectiveOn: at("2026-01-10") })], NOW)
    expect(sameDay.subscriptions).toMatchObject([{ endReason: "canceled", endedAt: at("2026-01-10"), cancelScheduledAt: null, cancelEffectiveAt: null }])

    // Scheduled for 31 January, then a move to $30 on 20 January: the $20 period keeps its schedule, the $30 one has none.
    const moved = derive(
      [
        ...sub,
        ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-10", "x.myshopify.com", { cancelEffectiveOn: at("2026-01-31") }),
        ev("SUBSCRIPTION_UPDATED", "2026-01-20", "x.myshopify.com", monthly(3000, null, "plus")),
      ],
      NOW,
    )
    expect(moved.subscriptions).toMatchObject([
      { monthlyCents: 2000, endReason: "replaced", cancelScheduledAt: at("2026-01-10"), cancelEffectiveAt: startOf("2026-01-31") },
      { monthlyCents: 3000, endedAt: null, cancelScheduledAt: null, cancelEffectiveAt: null },
    ])
  })
})

describe("plan changes Shopify reports as two events", () => {
  const base = [ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"), ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(1000, null, "basic"))]

  it("reads 'new plan created, old plan canceled' as one upgrade, and keeps the shop paying", () => {
    const r = derive(
      [
        ...base,
        ev("SUBSCRIPTION_CREATED", "2026-01-10T10:00:00Z", "x.myshopify.com", monthly(3000, null, "plus")),
        ev("SUBSCRIPTION_CANCELED", "2026-01-10T10:01:00Z", "x.myshopify.com", monthly(1000, null, "basic")),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-10")).toMatchObject({ expansionMrrCents: 2000, churnedMrrCents: 0, newMrrCents: 0, activeSubs: 1, mrrCents: 3000 })
    expect(r.daily.at(-1)).toMatchObject({ activeSubs: 1, mrrCents: 3000 })
    mrrAddsUp(r)
  })

  it("reads 'old plan canceled, new plan created' a few minutes later as one upgrade too", () => {
    const r = derive(
      [
        ...base,
        ev("SUBSCRIPTION_CANCELED", "2026-01-10T10:00:00Z", "x.myshopify.com", monthly(1000, null, "basic")),
        ev("SUBSCRIPTION_CREATED", "2026-01-10T10:04:00Z", "x.myshopify.com", monthly(3000, null, "plus")),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-10")).toMatchObject({ expansionMrrCents: 2000, churnedMrrCents: 0, newMrrCents: 0, canceledSubs: 0, activeSubs: 1, mrrCents: 3000 })
    expect(r.subscriptions.map((s) => s.endReason)).toEqual(["replaced", null])
    mrrAddsUp(r)
  })

  it("reads both at the same instant as one plan change, whatever order they come in", () => {
    const r = derive(
      [
        ...base,
        ev("SUBSCRIPTION_CREATED", "2026-01-10T10:00:00Z", "x.myshopify.com", monthly(500, null, "lite")),
        ev("SUBSCRIPTION_CANCELED", "2026-01-10T10:00:00Z", "x.myshopify.com", monthly(1000, null, "basic")),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-10")).toMatchObject({ contractionMrrCents: 500, churnedMrrCents: 0, activeSubs: 1, mrrCents: 500 })
  })

  it("counts a cancel, then a new subscription much later, as churn and a new sale", () => {
    const r = derive(
      [
        ...base,
        ev("SUBSCRIPTION_CANCELED", "2026-01-10T10:00:00Z", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-12T10:00:00Z", "x.myshopify.com", monthly(3000, null, "plus")),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-10")).toMatchObject({ churnedMrrCents: 1000, canceledSubs: 1, activeSubs: 0 })
    expect(dayOf(r, "2026-01-12")).toMatchObject({ newMrrCents: 3000, newSubs: 1, activeSubs: 1 })
  })

  it("honors a cancel of the current plan, even right after it began", () => {
    const r = derive(
      [
        ...base,
        ev("SUBSCRIPTION_CREATED", "2026-01-10T10:00:00Z", "x.myshopify.com", monthly(3000, null, "plus")),
        ev("SUBSCRIPTION_CANCELED", "2026-01-10T10:02:00Z", "x.myshopify.com", monthly(3000, null, "plus")),
      ],
      NOW,
    )
    expect(r.daily.at(-1)).toMatchObject({ activeSubs: 0, mrrCents: 0 })
  })

  it("honors a cancel that names no plan, since it cannot be told apart", () => {
    const r = derive([...base, ev("SUBSCRIPTION_CREATED", "2026-01-10T10:00:00Z", "x.myshopify.com", monthly(3000, null, "plus")), ev("SUBSCRIPTION_CANCELED", "2026-01-10T10:01:00Z", "x.myshopify.com")], NOW)
    expect(r.daily.at(-1)).toMatchObject({ activeSubs: 0 })
  })

  it("keeps a trial going through a plan change made by cancel and resubscribe", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(1000, 14, "basic")),
        ev("SUBSCRIPTION_CANCELED", "2026-01-05T10:00:00Z", "x.myshopify.com", monthly(1000, null, "basic")),
        ev("SUBSCRIPTION_CREATED", "2026-01-05T10:03:00Z", "x.myshopify.com", { ...monthly(3000, null, "plus"), trialDaysRemaining: 10 }),
      ],
      NOW,
    )
    expect(r.trials).toHaveLength(1)
    expect(r.trials[0].outcome).toBe("converted")
    expect(dayOf(r, "2026-01-15")).toMatchObject({ newMrrCents: 3000, activeSubs: 1, trialsConverted: 1 })
    expect(r.daily.every((d) => d.churnedMrrCents === 0)).toBe(true)
    mrrAddsUp(r)
  })
})

describe("churn by cause", () => {
  // x installs on 1 January and pays $20 a month from that day, with no trial.
  const x = "x.myshopify.com"
  const paying = [ev("RELATIONSHIP_INSTALLED", "2026-01-01", x), ev("SUBSCRIPTION_CREATED", "2026-01-01", x, monthly(2000))]
  const noInactiveChurn = (r: ReturnType<typeof derive>) => r.daily.every((d) => d.churnedMrrStoreInactiveCents === 0 && d.canceledSubsStoreInactive === 0)

  it("counts a freeze as the store going inactive, with or without a deactivation", () => {
    const alone = derive([...paying, ev("SUBSCRIPTION_FROZEN", "2026-01-10", x)], NOW)
    expect(dayOf(alone, "2026-01-10")).toMatchObject({
      churnedMrrCents: 2000, canceledSubs: 1, churnedMrrStoreInactiveCents: 2000, canceledSubsStoreInactive: 1, deactivations: 0, activeSubs: 0, mrrCents: 0,
    })
    mrrAddsUp(alone)

    const deactivated = derive([...paying, ev("SUBSCRIPTION_FROZEN", "2026-01-10", x), ev("RELATIONSHIP_DEACTIVATED", "2026-01-10", x)], NOW)
    expect(dayOf(deactivated, "2026-01-10")).toMatchObject({ churnedMrrStoreInactiveCents: 2000, canceledSubsStoreInactive: 1, deactivations: 1, activeInstalls: 1 })
  })

  it("counts a cancel while the store is deactivated as the store going inactive", () => {
    const r = derive([...paying, ev("RELATIONSHIP_DEACTIVATED", "2026-01-10", x), ev("SUBSCRIPTION_CANCELED", "2026-01-12", x)], NOW)
    // The deactivation alone moves no stock: the shop is still installed and still pays.
    expect(dayOf(r, "2026-01-10")).toMatchObject({ deactivations: 1, activeInstalls: 1, activeSubs: 1, mrrCents: 2000, churnedMrrCents: 0 })
    expect(dayOf(r, "2026-01-12")).toMatchObject({
      churnedMrrCents: 2000, canceledSubs: 1, churnedMrrStoreInactiveCents: 2000, canceledSubsStoreInactive: 1, activeSubs: 0, activeInstalls: 1,
    })
    mrrAddsUp(r)
  })

  it("counts an uninstall while the store is deactivated as the store going inactive, and the subscription it ends too", () => {
    const r = derive([...paying, ev("RELATIONSHIP_DEACTIVATED", "2026-01-10", x), ev("RELATIONSHIP_UNINSTALLED", "2026-01-15", x)], NOW)
    expect(dayOf(r, "2026-01-15")).toMatchObject({
      uninstalls: 1, uninstallsStoreInactive: 1, churnedMrrCents: 2000, churnedMrrStoreInactiveCents: 2000, canceledSubs: 1, canceledSubsStoreInactive: 1, activeInstalls: 0, activeSubs: 0,
    })
    expect(r.subscriptions[0].endReason).toBe("uninstalled")
    mrrAddsUp(r)
  })

  it("counts a cancel and an uninstall after the store came back as the merchant leaving", () => {
    const r = derive(
      [
        ...paying,
        ev("RELATIONSHIP_DEACTIVATED", "2026-01-05", x),
        ev("RELATIONSHIP_REACTIVATED", "2026-01-08", x),
        ev("SUBSCRIPTION_CANCELED", "2026-01-12", x),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-20", x),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-05")).toMatchObject({ deactivations: 1, reactivations: 0 })
    expect(dayOf(r, "2026-01-08")).toMatchObject({ deactivations: 0, reactivations: 1 })
    expect(dayOf(r, "2026-01-12")).toMatchObject({ churnedMrrCents: 2000, canceledSubs: 1, churnedMrrStoreInactiveCents: 0, canceledSubsStoreInactive: 0 })
    expect(dayOf(r, "2026-01-20")).toMatchObject({ uninstalls: 1, uninstallsStoreInactive: 0 })
    mrrAddsUp(r)
  })

  it("counts a move to a free plan as the merchant leaving, even while the store is deactivated", () => {
    const r = derive([...paying, ev("RELATIONSHIP_DEACTIVATED", "2026-01-05", x), ev("SUBSCRIPTION_UPDATED", "2026-01-10", x, { ...monthly(0), planHandle: "free" })], NOW)
    expect(dayOf(r, "2026-01-10")).toMatchObject({ churnedMrrCents: 2000, canceledSubs: 1, churnedMrrStoreInactiveCents: 0, canceledSubsStoreInactive: 0 })
  })

  it("counts a deactivation with no paying subscription, and the uninstall that follows, without any churn", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", x),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", x, { ...monthly(0), planHandle: "free" }),
        ev("RELATIONSHIP_DEACTIVATED", "2026-01-10", x),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-20", x),
        // Installed before the history starts: only its deactivation and uninstall are seen.
        ev("RELATIONSHIP_DEACTIVATED", "2026-01-11", "old.myshopify.com"),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-21", "old.myshopify.com"),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-10")).toMatchObject({ deactivations: 1, activeInstalls: 1 })
    expect(dayOf(r, "2026-01-20")).toMatchObject({ uninstalls: 1, uninstallsStoreInactive: 1, canceledSubs: 0, churnedMrrCents: 0, activeInstalls: 0 })
    expect(dayOf(r, "2026-01-21")).toMatchObject({ uninstalls: 1, uninstallsStoreInactive: 1, activeInstalls: 0 })
    expect(r.orphanUninstalls).toBe(1)
    expect(noInactiveChurn(r)).toBe(true)
  })

  it("never counts a trial that ends while the store is deactivated as churn", () => {
    const y = "y.myshopify.com"
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", x),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", x, monthly(2000, 14)),
        ev("RELATIONSHIP_DEACTIVATED", "2026-01-03", x),
        ev("SUBSCRIPTION_CANCELED", "2026-01-04", x),
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", y),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", y, monthly(3000, 14)),
        ev("RELATIONSHIP_DEACTIVATED", "2026-01-04", y),
        ev("SUBSCRIPTION_FROZEN", "2026-01-04", y),
      ],
      NOW,
    )
    expect(r.trials.map((t) => t.outcome)).toEqual(["canceled", "canceled"])
    expect(dayOf(r, "2026-01-04")).toMatchObject({ trialsCanceled: 2, canceledSubs: 0, churnedMrrCents: 0, trialSubs: 0, trialMrrCents: 0 })
    expect(noInactiveChurn(r)).toBe(true)
    mrrAddsUp(r)
  })

  it("forgets a deactivation from before the shop's latest install", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", x),
        ev("RELATIONSHIP_DEACTIVATED", "2026-01-05", x),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-06", x),
        ev("RELATIONSHIP_INSTALLED", "2026-01-10", x),
        ev("SUBSCRIPTION_CREATED", "2026-01-10", x, monthly(2000)),
        ev("SUBSCRIPTION_CANCELED", "2026-01-20", x),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-21", x),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-06")).toMatchObject({ uninstalls: 1, uninstallsStoreInactive: 1 })
    expect(dayOf(r, "2026-01-20")).toMatchObject({ churnedMrrCents: 2000, churnedMrrStoreInactiveCents: 0, canceledSubsStoreInactive: 0 })
    expect(dayOf(r, "2026-01-21")).toMatchObject({ uninstalls: 1, uninstallsStoreInactive: 0 })
  })

  it("puts a deactivation before what happens at the same instant, and a reactivation after it", () => {
    const deactivate = ev("RELATIONSHIP_DEACTIVATED", "2026-01-10", x)
    const cancel = ev("SUBSCRIPTION_CANCELED", "2026-01-10", x)
    for (const order of [[deactivate, cancel], [cancel, deactivate]]) {
      expect(dayOf(derive([...paying, ...order], NOW), "2026-01-10")).toMatchObject({ churnedMrrStoreInactiveCents: 2000, canceledSubsStoreInactive: 1 })
    }
    const reactivate = ev("RELATIONSHIP_REACTIVATED", "2026-01-10", x)
    const r = derive([...paying, ev("RELATIONSHIP_DEACTIVATED", "2026-01-05", x), reactivate, cancel], NOW)
    expect(dayOf(r, "2026-01-10")).toMatchObject({ churnedMrrStoreInactiveCents: 2000, reactivations: 1 })
  })

  it("judges a cancel that takes effect later by the store's state on the day it takes effect", () => {
    // Scheduled while the store was active; Shopify deactivated the store before the date.
    const closed = derive(
      [...paying, ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-05", x, { cancelEffectiveOn: at("2026-01-20") }), ev("RELATIONSHIP_DEACTIVATED", "2026-01-10", x)],
      NOW,
    )
    expect(dayOf(closed, "2026-01-20")).toMatchObject({ churnedMrrCents: 2000, churnedMrrStoreInactiveCents: 2000, canceledSubsStoreInactive: 1 })

    // Scheduled while the store was deactivated; it came back before the date.
    const back = derive(
      [
        ...paying,
        ev("RELATIONSHIP_DEACTIVATED", "2026-01-03", x),
        ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-01-05", x, { cancelEffectiveOn: at("2026-01-20") }),
        ev("RELATIONSHIP_REACTIVATED", "2026-01-10", x),
      ],
      NOW,
    )
    expect(dayOf(back, "2026-01-20")).toMatchObject({ churnedMrrCents: 2000, churnedMrrStoreInactiveCents: 0, canceledSubsStoreInactive: 0 })
  })

  it("never splits out more than the total", () => {
    for (const d of result.daily) {
      expect(d.uninstallsStoreInactive, d.date).toBeLessThanOrEqual(d.uninstalls)
      expect(d.canceledSubsStoreInactive, d.date).toBeLessThanOrEqual(d.canceledSubs)
      expect(d.churnedMrrStoreInactiveCents, d.date).toBeLessThanOrEqual(d.churnedMrrCents)
    }
  })
})

describe("subscription events after an uninstall", () => {
  // Shopify cancels an app's subscriptions when the app is uninstalled. Until the shop installs it
  // again, a creation or an update that Shopify sends late opens and changes nothing.
  const x = "x.myshopify.com"
  const y = "y.myshopify.com"

  it("ignores a plan change and a new subscription between an uninstall and the next install", () => {
    // y pays $10 from 1 January. x pays $20 from 5 January and uninstalls on 10 January; a plan
    // change to $30 on 15 January and a new subscription with a trial on 20 January follow.
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", y),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", y, monthly(1000, null, "basic")),
        ev("RELATIONSHIP_INSTALLED", "2026-01-05", x),
        ev("SUBSCRIPTION_CREATED", "2026-01-05", x, monthly(2000)),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-10", x),
        ev("SUBSCRIPTION_UPDATED", "2026-01-15", x, monthly(3000, null, "plus")),
        ev("SUBSCRIPTION_CREATED", "2026-01-20", x, monthly(2000, 7)),
      ],
      NOW,
    )
    expect(r.ignoredAfterUninstall).toBe(2)
    expect(r.subscriptions.filter((p) => p.shop === x)).toMatchObject([{ kind: "new", monthlyCents: 2000, endReason: "uninstalled" }])
    expect(r.trials).toHaveLength(0)
    expect(dayOf(r, "2026-01-04")).toMatchObject({ activeSubs: 1, mrrCents: 1000 })
    expect(dayOf(r, "2026-01-05")).toMatchObject({ newMrrCents: 2000, newSubs: 1, activeSubs: 2, mrrCents: 3000 })
    expect(dayOf(r, "2026-01-10")).toMatchObject({ uninstalls: 1, churnedMrrCents: 2000, canceledSubs: 1, activeInstalls: 1, activeSubs: 1, mrrCents: 1000 })
    // MRR is back to what it was before x subscribed, and stays there.
    expect(dayOf(r, "2026-01-15")).toMatchObject({ newMrrCents: 0, expansionMrrCents: 0, newSubs: 0, activeSubs: 1, mrrCents: 1000 })
    expect(dayOf(r, "2026-01-20")).toMatchObject({ newMrrCents: 0, newSubs: 0, trialsStarted: 0, trialSubs: 0, activeSubs: 1, mrrCents: 1000 })
    expect(r.daily.at(-1)).toMatchObject({ activeInstalls: 1, activeSubs: 1, mrrCents: 1000, trialSubs: 0 })
    mrrAddsUp(r)
  })

  it("opens a period again once the shop reinstalls", () => {
    // x pays $20 from 1 January and uninstalls on 10 January. A plan change on 15 January is
    // ignored. x installs again on 20 January and subscribes to $30 at the same moment.
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", x),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", x, monthly(2000)),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-10", x),
        ev("SUBSCRIPTION_UPDATED", "2026-01-15", x, monthly(2500)),
        // In this order on purpose: at the same instant the install still comes first.
        ev("SUBSCRIPTION_CREATED", "2026-01-20", x, monthly(3000, null, "plus")),
        ev("RELATIONSHIP_INSTALLED", "2026-01-20", x),
      ],
      NOW,
    )
    expect(r.ignoredAfterUninstall).toBe(1)
    expect(r.subscriptions).toMatchObject([
      { kind: "new", monthlyCents: 2000, endReason: "uninstalled" },
      { kind: "new", monthlyCents: 3000, planHandle: "plus", previousMonthlyCents: null, endedAt: null },
    ])
    expect(dayOf(r, "2026-01-15")).toMatchObject({ newMrrCents: 0, activeSubs: 0, mrrCents: 0 })
    expect(dayOf(r, "2026-01-20")).toMatchObject({ installs: 1, reinstalls: 1, newMrrCents: 3000, newSubs: 1, activeInstalls: 1, activeSubs: 1, mrrCents: 3000 })
    expect(r.daily.at(-1)).toMatchObject({ activeSubs: 1, mrrCents: 3000 })
    mrrAddsUp(r)
  })

  it("handles an update at the same instant as an uninstall before the uninstall", () => {
    // x pays $20 from 1 January. On 10 January at noon Shopify reports a move to $30 and the uninstall.
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", x),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", x, monthly(2000)),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-10T12:00:00Z", x),
        ev("SUBSCRIPTION_UPDATED", "2026-01-10T12:00:00Z", x, monthly(3000, null, "plus")),
      ],
      NOW,
    )
    expect(r.ignoredAfterUninstall).toBe(0)
    // The plan change happens, and the uninstall ends the new plan the moment it begins.
    expect(r.subscriptions).toMatchObject([
      { kind: "new", monthlyCents: 2000, endReason: "replaced" },
      { kind: "change", monthlyCents: 3000, previousMonthlyCents: 2000, endReason: "uninstalled" },
    ])
    expect(r.subscriptions[1].endedAt).toEqual(r.subscriptions[1].startedAt)
    // The new plan never paid, so the $20 is what was lost.
    expect(dayOf(r, "2026-01-10")).toMatchObject({ uninstalls: 1, expansionMrrCents: 0, churnedMrrCents: 2000, canceledSubs: 1, activeInstalls: 0, activeSubs: 0, mrrCents: 0 })
    mrrAddsUp(r)
  })

  it("still gives a shop with no install in the history its periods, up to its uninstall", () => {
    // x installed before the history starts. Its subscription is first seen in an update ($20 on
    // 5 January), moves to $30 on 15 January, and ends with the uninstall on 20 January. A plan
    // change on 25 January comes after the uninstall.
    const r = derive(
      [
        ev("SUBSCRIPTION_UPDATED", "2026-01-05", x, monthly(2000)),
        ev("SUBSCRIPTION_CREATED", "2026-01-15", x, monthly(3000, null, "plus")),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-20", x),
        ev("SUBSCRIPTION_UPDATED", "2026-01-25", x, monthly(3000, null, "plus")),
      ],
      NOW,
    )
    expect(r.subscriptions).toMatchObject([
      { kind: "new", monthlyCents: 2000, endReason: "replaced" },
      { kind: "change", monthlyCents: 3000, previousMonthlyCents: 2000, endReason: "uninstalled" },
    ])
    expect(r).toMatchObject({ orphanUninstalls: 1, ignoredAfterUninstall: 1 })
    expect(dayOf(r, "2026-01-05")).toMatchObject({ newMrrCents: 2000, newSubs: 1, activeSubs: 1, mrrCents: 2000 })
    expect(dayOf(r, "2026-01-15")).toMatchObject({ expansionMrrCents: 1000, newMrrCents: 0, activeSubs: 1, mrrCents: 3000 })
    expect(dayOf(r, "2026-01-20")).toMatchObject({ uninstalls: 1, churnedMrrCents: 3000, canceledSubs: 1, activeInstalls: 0, activeSubs: 0, mrrCents: 0 })
    expect(dayOf(r, "2026-01-25")).toMatchObject({ newMrrCents: 0, activeSubs: 0, mrrCents: 0 })
    mrrAddsUp(r)
  })

  it("ignores an unfreeze between an uninstall and the next install", () => {
    // y pays $10 from 1 January. x pays $20 from 1 January; Shopify freezes it on 10 January, x
    // uninstalls on 15 January, and an unfreeze follows on 20 January.
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", y),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", y, monthly(1000, null, "basic")),
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", x),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", x, monthly(2000)),
        ev("SUBSCRIPTION_FROZEN", "2026-01-10", x),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-15", x),
        ev("SUBSCRIPTION_UNFROZEN", "2026-01-20", x),
      ],
      NOW,
    )
    expect(r.ignoredAfterUninstall).toBe(1)
    expect(r.subscriptions.filter((p) => p.shop === x)).toMatchObject([{ kind: "new", monthlyCents: 2000, endReason: "frozen" }])
    // The freeze is the loss. The uninstall ends nothing more, and the unfreeze brings nothing back.
    expect(dayOf(r, "2026-01-10")).toMatchObject({ churnedMrrCents: 2000, churnedMrrStoreInactiveCents: 2000, canceledSubs: 1, activeSubs: 1, mrrCents: 1000 })
    expect(dayOf(r, "2026-01-15")).toMatchObject({ uninstalls: 1, churnedMrrCents: 0, canceledSubs: 0, activeInstalls: 1, activeSubs: 1, mrrCents: 1000 })
    expect(dayOf(r, "2026-01-20")).toMatchObject({ newMrrCents: 0, newSubs: 0, activeSubs: 1, mrrCents: 1000 })
    expect(r.daily.at(-1)).toMatchObject({ activeInstalls: 1, activeSubs: 1, mrrCents: 1000 })
    mrrAddsUp(r)
  })
})

describe("edge cases", () => {
  it("returns nothing for no events", () => {
    expect(derive([], NOW)).toEqual({ installs: [], subscriptions: [], trials: [], daily: [], orphanUninstalls: 0, ignoredAfterUninstall: 0 })
  })

  it("orders events on the same instant: install, then subscription, then uninstall", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-01T10:00:00Z", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01T10:00:00Z", "x.myshopify.com", monthly(1000)),
        ev("RELATIONSHIP_INSTALLED", "2026-01-01T10:00:00Z", "x.myshopify.com"),
      ],
      NOW,
    )
    expect(r.installs).toHaveLength(1)
    expect(r.installs[0].uninstalledAt).not.toBeNull()
    expect(r.subscriptions[0].endReason).toBe("uninstalled")
    expect(r.orphanUninstalls).toBe(0)
  })

  it("treats a move to a free plan as churn, and a move off one as new revenue", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(2000)),
        ev("SUBSCRIPTION_UPDATED", "2026-01-10", "x.myshopify.com", { ...monthly(0), planHandle: "free" }),
        ev("SUBSCRIPTION_UPDATED", "2026-01-20", "x.myshopify.com", monthly(2000)),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-10")).toMatchObject({ churnedMrrCents: 2000, canceledSubs: 1, mrrCents: 0, activeSubs: 0 })
    expect(dayOf(r, "2026-01-20")).toMatchObject({ newMrrCents: 2000, newSubs: 1, mrrCents: 2000, activeSubs: 1 })
    mrrAddsUp(r)
  })

  it("books a downgrade as contraction", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(3000)),
        ev("SUBSCRIPTION_UPDATED", "2026-01-10", "x.myshopify.com", monthly(1000)),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-10")).toMatchObject({ contractionMrrCents: 2000, churnedMrrCents: 0, mrrCents: 1000 })
  })

  it("reads a second 'created' on an open subscription as a plan change", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(1000)),
        ev("SUBSCRIPTION_CREATED", "2026-01-05", "x.myshopify.com", monthly(2000)),
      ],
      NOW,
    )
    expect(dayOf(r, "2026-01-05")).toMatchObject({ expansionMrrCents: 1000, newMrrCents: 0, activeSubs: 1, mrrCents: 2000 })
  })

  it("does not count a $0 subscription as a subscriber", () => {
    const r = derive([ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"), ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(0))], NOW)
    expect(r.daily[0]).toMatchObject({ activeSubs: 0, mrrCents: 0, newSubs: 0 })
  })

  it("uninstalling ends the subscription, and ends a trial in progress as canceled, never paid", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(2000, 14)),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-03", "x.myshopify.com"),
      ],
      NOW,
    )
    expect(r.subscriptions[0]).toMatchObject({ endReason: "uninstalled" })
    expect(r.trials[0].outcome).toBe("canceled")
    expect(dayOf(r, "2026-01-03")).toMatchObject({ churnedMrrCents: 0, activeSubs: 0, trialSubs: 0, trialsCanceled: 1 })
  })

  it("opens a subscription whose creation was before the history from its first update, and keeps a trial Shopify says is running", () => {
    const r = derive(
      [
        ev("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        ev("SUBSCRIPTION_UPDATED", "2026-01-05", "x.myshopify.com", { ...monthly(2000), trialDaysRemaining: 4 }),
      ],
      NOW,
    )
    expect(r.subscriptions).toHaveLength(1)
    expect(r.trials[0]).toMatchObject({ trialDays: 4, outcome: "converted" })
    expect(dayOf(r, "2026-01-08")).toMatchObject({ activeSubs: 0, trialSubs: 1 })
    expect(dayOf(r, "2026-01-09")).toMatchObject({ activeSubs: 1, newMrrCents: 2000 })
  })

  it("puts an event dated after now on the last day instead of losing it", () => {
    const r = derive([ev("RELATIONSHIP_INSTALLED", "2026-03-01", "x.myshopify.com")], NOW)
    expect(r.daily).toHaveLength(1)
    expect(r.daily[0].installs).toBe(1)
  })

  it("does not choke on events with no shop", () => {
    const r = derive([ev("CHARGE_RECURRING", "2026-01-01", null, { amountCents: 500 })], NOW)
    expect(r.daily[0].chargedCents).toBe(500)
    expect(r.installs).toHaveLength(0)
  })
})

describe("billing screen events from the older App.events", () => {
  // They share the SUBSCRIPTION_ prefix with the events derive() reads, and carry a price.
  const billing = [
    // Before the first event of the history, from a shop seen nowhere else.
    ev("SUBSCRIPTION_CHARGE_DECLINED", "2025-12-30", "z.myshopify.com", { amountCents: 2000 }),
    // On the same instant as A's subscription, and on the day its trial converts.
    ev("SUBSCRIPTION_CHARGE_ACCEPTED", "2026-01-01T11:00:00Z", "a.myshopify.com", { amountCents: 2000 }),
    ev("ONE_TIME_CHARGE_ACCEPTED", "2026-01-08T11:00:00Z", "a.myshopify.com", { amountCents: 500 }),
    // B never paid; C has no plan at all.
    ev("SUBSCRIPTION_CHARGE_EXPIRED", "2026-01-03", "b.myshopify.com", { amountCents: 24000 }),
    ev("ONE_TIME_CHARGE_DECLINED", "2026-01-12", "c.myshopify.com", { amountCents: 500 }),
    ev("ONE_TIME_CHARGE_EXPIRED", "2026-01-13", "c.myshopify.com", { amountCents: 500 }),
    // E's plan while it is frozen, and after.
    ev("SUBSCRIPTION_APPROACHING_CAPPED_AMOUNT", "2026-01-15T18:00:00Z", "e.myshopify.com", { amountCents: 1000 }),
    ev("SUBSCRIPTION_CAPPED_AMOUNT_UPDATED", "2026-01-20", "e.myshopify.com", { amountCents: 5000 }),
    ev("SUBSCRIPTION_CHARGE_DECLINED", "2026-02-09", null),
  ]

  it("covers every type the legacy pass reads", () => {
    expect(new Set(billing.map((e) => e.type))).toEqual(new Set(LEGACY_EVENT_TYPES))
  })

  it("changes nothing derive() returns", () => {
    const mixed = [billing[0], ...history.slice(0, 5), ...billing.slice(1, 5), ...history.slice(5), ...billing.slice(5)]
    expect(mixed).toHaveLength(history.length + billing.length)
    expect(derive(mixed, NOW)).toEqual(result)
  })

  it("gives an app with nothing else no rows at all", () => {
    expect(derive(billing, NOW)).toEqual(derive([], NOW))
  })
})
