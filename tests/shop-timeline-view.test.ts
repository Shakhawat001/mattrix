import { describe, expect, it } from "vitest"
import { derive, rankOf } from "@/lib/analytics/derive"
import type { ShopTimeline, TimelineEvent } from "@/lib/analytics/shop-timeline"
import { parseShopParam, reasonsLabel, shopStanding, timelineRows, type TimelineRow } from "@/lib/analytics/shop-timeline-view"

const NOW = new Date("2026-02-10T12:00:00Z")
const SHOP = "a.myshopify.com"

let counter = 0
function ev(type: string, when: string, over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: `evt-${String(++counter).padStart(6, "0")}`,
    type,
    occurredAt: new Date(when.length === 10 ? `${when}T12:00:00Z` : when),
    state: null,
    planHandle: null,
    billingPeriod: null,
    trialDays: null,
    trialDaysRemaining: null,
    cancelEffectiveOn: null,
    amountCents: null,
    currency: "USD",
    grossCents: null,
    netCents: null,
    feeCents: null,
    reason: null,
    reasonDescription: null,
    ...over,
  }
}
const monthly = (amountCents: number | null, trialDays: number | null = null, planHandle = "pro") => ({ amountCents, trialDays, planHandle, billingPeriod: "EVERY_30_DAYS" })

/**
 * What getShopTimeline returns for these events: derive()'s stays, periods and trials of the shop,
 * and the events in the read's order (by time, then derive()'s rank, then id).
 */
function timelineOf(list: TimelineEvent[], now = NOW): ShopTimeline {
  const d = derive(
    list.map((e) => ({ ...e, shop: SHOP })),
    now,
    "UTC",
  )
  return {
    appId: "app",
    shop: SHOP,
    stays: d.installs,
    subscriptions: d.subscriptions,
    trials: d.trials,
    events: [...list].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || rankOf(a.type) - rankOf(b.type) || (a.id < b.id ? -1 : 1)),
    eventCount: list.length,
  }
}
const said = (rows: TimelineRow[]) => rows.map((r) => ({ title: r.title, detail: r.detail }))

describe("the shop timeline in plain words", () => {
  // The history of tests/derive.test.ts, shop A: a 7-day trial on $20 from 1 Jan that converts on
  // 8 Jan, a move to $30 on 20 Jan, a cancel and an uninstall on 5 Feb.
  const historyA = () => [
    ev("RELATIONSHIP_INSTALLED", "2026-01-01T10:00:00Z", { state: "INSTALLED" }),
    ev("SUBSCRIPTION_CREATED", "2026-01-01T11:00:00Z", monthly(2000, 7)),
    ev("CHARGE_RECURRING", "2026-01-08T11:00:00Z", { amountCents: 2000, planHandle: "pro" }),
    ev("EARNING_CHARGE_RECURRING", "2026-01-11", { grossCents: 2000, netCents: 1700, feeCents: 300 }),
    ev("SUBSCRIPTION_UPDATED", "2026-01-20", monthly(3000)),
    ev("SUBSCRIPTION_CANCELED", "2026-02-05T09:00:00Z"),
    ev("RELATIONSHIP_UNINSTALLED", "2026-02-05T12:00:00Z", { reason: "too_expensive", reasonDescription: "Too much for us" }),
  ]

  it("tells a whole stay, oldest first, with the trial worked out from the events", () => {
    const rows = timelineRows(timelineOf(historyA()), "UTC")
    expect(rows.map((r) => ({ at: r.at.toISOString(), title: r.title, detail: r.detail, quote: r.quote }))).toEqual([
      { at: "2026-01-01T10:00:00.000Z", title: "Installed", detail: null, quote: null },
      { at: "2026-01-01T11:00:00.000Z", title: "Subscribed", detail: "pro at $20 a month", quote: null },
      { at: "2026-01-01T11:00:00.000Z", title: "Trial started", detail: "7 days, set to end Jan 8, 2026, 11:00 UTC", quote: null },
      // The trial ends at the moment the first charge comes in: the conversion is told first.
      { at: "2026-01-08T11:00:00.000Z", title: "Trial converted", detail: "Started paying for pro at $20 a month", quote: null },
      { at: "2026-01-08T11:00:00.000Z", title: "Recurring charge", detail: "$20 for pro", quote: null },
      { at: "2026-01-11T12:00:00.000Z", title: "Earnings: recurring", detail: "$20 gross, $17 net, Shopify's fee $3", quote: null },
      { at: "2026-01-20T12:00:00.000Z", title: "Plan changed", detail: "From pro at $20 a month to pro at $30 a month", quote: null },
      { at: "2026-02-05T09:00:00.000Z", title: "Canceled", detail: null, quote: null },
      // 1 Jan 10:00 to 5 Feb 12:00 is 35 days and 2 hours.
      { at: "2026-02-05T12:00:00.000Z", title: "Uninstalled", detail: "Reason: Too expensive. Installed for 35 days", quote: "Too much for us" },
    ])
    expect(rows.map((r) => r.type)).toEqual([
      "RELATIONSHIP_INSTALLED", "SUBSCRIPTION_CREATED", null, null, "CHARGE_RECURRING", "EARNING_CHARGE_RECURRING", "SUBSCRIPTION_UPDATED", "SUBSCRIPTION_CANCELED", "RELATIONSHIP_UNINSTALLED",
    ])
    expect(rows.map((r) => r.tone)).toEqual(["plain", "plain", "plain", "plain", "money", "money", "plain", "loss", "loss"])
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  it("reads a second subscription while one is open as a plan change, and names a yearly price", () => {
    const rows = timelineRows(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-02T09:00:00Z"),
        ev("SUBSCRIPTION_CREATED", "2026-01-02T09:30:00Z", monthly(1000, null, "basic")),
        ev("SUBSCRIPTION_CREATED", "2026-01-15T10:00:00Z", { planHandle: "pro", billingPeriod: "ANNUAL", amountCents: 24000 }),
        // Shopify cancels the old plan moments later.
        ev("SUBSCRIPTION_CANCELED", "2026-01-15T10:02:00Z", monthly(1000, null, "basic")),
        ev("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-02-01T08:00:00Z", { planHandle: "pro", billingPeriod: "ANNUAL", amountCents: 24000, cancelEffectiveOn: new Date("2026-03-01T00:00:00Z") }),
      ]),
      "UTC",
    )
    expect(said(rows)).toEqual([
      { title: "Installed", detail: null },
      { title: "Subscribed", detail: "basic at $10 a month" },
      { title: "Plan changed", detail: "From basic at $10 a month to pro at $20 a month, billed $240 a year" },
      { title: "Canceled", detail: "basic at $10 a month" },
      { title: "Cancellation scheduled", detail: "pro at $20 a month, billed $240 a year. Takes effect Mar 1, 2026" },
    ])
    expect(rows[4].tone).toBe("loss")
  })

  it("reads a cancel and a new subscription minutes apart as a plan change, and says when a cancel takes effect", () => {
    const rows = timelineRows(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-03T09:00:00Z"),
        ev("SUBSCRIPTION_CREATED", "2026-01-03T09:10:00Z", monthly(1000, null, "basic")),
        ev("SUBSCRIPTION_CANCELED", "2026-01-10T12:00:00Z"),
        ev("SUBSCRIPTION_CREATED", "2026-01-10T12:05:00Z", monthly(3000)),
        ev("SUBSCRIPTION_CANCELED", "2026-01-20T12:00:00Z", { cancelEffectiveOn: new Date("2026-02-01T00:00:00Z") }),
        // A cancel whose date is not later than itself takes effect at once: no date to tell.
        ev("SUBSCRIPTION_CANCELED", "2026-02-02T12:00:00Z", { cancelEffectiveOn: new Date("2026-02-02T00:00:00Z") }),
      ]),
      "UTC",
    )
    expect(said(rows)).toEqual([
      { title: "Installed", detail: null },
      { title: "Subscribed", detail: "basic at $10 a month" },
      { title: "Canceled", detail: null },
      { title: "Plan changed", detail: "From basic at $10 a month to pro at $30 a month" },
      { title: "Canceled", detail: "Takes effect Feb 1, 2026" },
      { title: "Canceled", detail: null },
    ])
  })

  it("tells a trial canceled after its cancel, every reason given, the length of each stay, and each return", () => {
    const rows = timelineRows(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-02T09:00:00Z"),
        ev("SUBSCRIPTION_CREATED", "2026-01-02T09:30:00Z", { amountCents: 24000, billingPeriod: "ANNUAL", trialDays: 7, planHandle: "yearly" }),
        ev("SUBSCRIPTION_CANCELED", "2026-01-05T09:00:00Z"),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-05T09:05:00Z", { reason: "app_not_working, too_expensive" }),
        ev("RELATIONSHIP_INSTALLED", "2026-01-12T12:00:00Z"),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-12T15:00:00Z"),
        ev("RELATIONSHIP_INSTALLED", "2026-01-20T12:00:00Z"),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-20T12:20:00Z", { reason: " ,  " }),
      ]),
      "UTC",
    )
    expect(said(rows)).toEqual([
      { title: "Installed", detail: null },
      { title: "Subscribed", detail: "yearly at $20 a month, billed $240 a year" },
      { title: "Trial started", detail: "7 days, set to end Jan 9, 2026, 09:30 UTC" },
      { title: "Canceled", detail: null },
      { title: "Trial canceled", detail: "The subscription ended during the trial" },
      // 2 Jan 09:00 to 5 Jan 09:05.
      { title: "Uninstalled", detail: "Reason: App not working, Too expensive. Installed for 3.0 days" },
      { title: "Reinstalled", detail: "Install 2 of this shop" },
      { title: "Uninstalled", detail: "No reason given. Installed for 3 hours" },
      { title: "Reinstalled", detail: "Install 3 of this shop" },
      { title: "Uninstalled", detail: "No reason given. Installed for less than an hour" },
    ])
    expect(rows.map((r) => r.quote).every((q) => q === null)).toBe(true)
    expect(rows[4]).toMatchObject({ type: null, tone: "loss", key: "trial-0-end" })
  })

  it("tells the plan a trial converted to in the words its subscription began with", () => {
    const rows = timelineRows(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-04T10:00:00Z"),
        ev("SUBSCRIPTION_CREATED", "2026-01-04T11:00:00Z", { amountCents: 9900, billingPeriod: "ANNUAL", trialDays: 14, planHandle: "plus" }),
      ]),
      "UTC",
    )
    expect(said(rows).slice(1)).toEqual([
      { title: "Subscribed", detail: "plus at $8.25 a month, billed $99 a year" },
      { title: "Trial started", detail: "14 days, set to end Jan 18, 2026, 11:00 UTC" },
      // No charge yet: it converts when the trial ends with the subscription still open.
      { title: "Trial converted", detail: "Started paying for plus at $8.25 a month, billed $99 a year" },
    ])
  })

  it("tells a freeze and a store deactivation, and what each came back to", () => {
    const rows = timelineRows(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-10T12:00:00Z"),
        ev("SUBSCRIPTION_CREATED", "2026-01-10T12:00:00Z", monthly(1000, null, "basic")),
        ev("RELATIONSHIP_DEACTIVATED", "2026-01-14T12:00:00Z", { reason: "store_closed" }),
        ev("SUBSCRIPTION_FROZEN", "2026-01-15T12:00:00Z"),
        ev("RELATIONSHIP_REACTIVATED", "2026-01-16T11:00:00Z"),
        ev("SUBSCRIPTION_UNFROZEN", "2026-01-16T12:00:00Z"),
      ]),
      "UTC",
    )
    expect(said(rows)).toEqual([
      { title: "Installed", detail: null },
      { title: "Subscribed", detail: "basic at $10 a month" },
      { title: "Store deactivated", detail: "Shopify deactivated the shop's billing account. Reason: Store closed" },
      { title: "Frozen", detail: "On hold for non-payment until payments resume" },
      { title: "Store reactivated", detail: "Shopify reactivated the shop's billing account" },
      { title: "Unfrozen", detail: "Billing resumed: basic at $10 a month" },
    ])
    expect(rows.map((r) => r.tone)).toEqual(["plain", "plain", "loss", "loss", "plain", "plain"])
  })

  it("names charges by kind, earnings, refunds and credits, each with its sign", () => {
    const rows = timelineRows(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-01"),
        ev("CHARGE_ONE_TIME", "2026-01-02", { amountCents: 5000 }),
        ev("CHARGE_USAGE", "2026-01-03", { amountCents: 125 }),
        ev("CHARGE_RECURRING", "2026-01-04"),
        ev("EARNING_CHARGE_ONE_TIME", "2026-01-05", { grossCents: 5000, netCents: 4000, feeCents: 1000 }),
        ev("EARNING_CHARGE_USAGE", "2026-01-06", { grossCents: 125, netCents: 100, feeCents: 25 }),
        ev("EARNING_REFUND", "2026-01-07", { grossCents: -5000, netCents: -4000, feeCents: -1000 }),
        ev("EARNING_ADJUSTMENT", "2026-01-08", { grossCents: -300, netCents: -300 }),
        ev("EARNING_CREDIT", "2026-01-09", { grossCents: 1000, netCents: 1000, feeCents: 0 }),
        ev("CREDIT_PENDING", "2026-01-10", { amountCents: 1500 }),
        ev("CREDIT_APPLIED", "2026-01-11", { amountCents: 1500 }),
        ev("CREDIT_FAILED", "2026-01-12", { amountCents: 700 }),
      ]),
      "UTC",
    )
    expect(said(rows).slice(1)).toEqual([
      { title: "One-time charge", detail: "$50" },
      { title: "Usage charge", detail: "$1.25" },
      { title: "Recurring charge", detail: "No amount reported" },
      { title: "Earnings: one-time", detail: "$50 gross, $40 net, Shopify's fee $10" },
      { title: "Earnings: usage", detail: "$1.25 gross, $1 net, Shopify's fee $0.25" },
      { title: "Refund", detail: "-$50 gross, -$40 net, Shopify's fee -$10" },
      { title: "Adjustment", detail: "-$3 gross, -$3 net" },
      { title: "Earnings: credit", detail: "$10 gross, $10 net, Shopify's fee $0" },
      { title: "Credit pending", detail: "$15 of app credit" },
      { title: "Credit applied", detail: "$15 of app credit" },
      { title: "Credit failed", detail: "$7 of app credit" },
    ])
    expect(rows.slice(1).map((r) => r.tone)).toEqual(["money", "money", "money", "money", "money", "loss", "money", "money", "money", "money", "money"])
  })

  it("tells what each payout record left you after every Shopify fee, a refund as a loss", () => {
    const rows = timelineRows(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-01"),
        ev("APP_SUBSCRIPTION_SALE", "2026-01-02", { grossCents: 2499, netCents: 2427, feeCents: 0 }),
        ev("APP_ONE_TIME_SALE", "2026-01-03", { grossCents: 5000, netCents: 4855, feeCents: 0 }),
        ev("APP_USAGE_SALE", "2026-01-04", { grossCents: null, netCents: 97, feeCents: null }),
        // Shopify may send a credit's gross without a sign: it takes the sign of what left the payout.
        ev("APP_SALE_CREDIT", "2026-01-05", { grossCents: 2499, netCents: -2449, feeCents: 0 }),
        ev("APP_SALE_ADJUSTMENT", "2026-01-06", { grossCents: -2499, netCents: -2427, feeCents: 0 }),
      ]),
      "UTC",
    )
    expect(said(rows).slice(1)).toEqual([
      { title: "Payout record: recurring", detail: "$24.99 gross, $24.27 to your payout, Shopify's fees $0.72" },
      { title: "Payout record: one-time", detail: "$50 gross, $48.55 to your payout, Shopify's fees $1.45" },
      { title: "Payout record: usage", detail: "$0.97 gross, $0.97 to your payout, Shopify's fees $0" },
      { title: "Payout record: credit", detail: "-$24.99 gross, -$24.49 to your payout, Shopify's fees -$0.50" },
      { title: "Payout record: adjustment", detail: "-$24.99 gross, -$24.27 to your payout, Shopify's fees -$0.72" },
    ])
    expect(rows.slice(1).map((r) => r.tone)).toEqual(["money", "money", "money", "money", "loss"])
  })

  it("keeps the merchant's words exactly as Shopify sent them, on any event that has them", () => {
    const words = `He said "no" & <b>left</b>\n  Second line, with   spaces. Très cher 💸`
    const rows = timelineRows(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-01"),
        ev("RELATIONSHIP_DEACTIVATED", "2026-01-02", { reasonDescription: "Closed for winter" }),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-03", { reason: "other", reasonDescription: words }),
        ev("RELATIONSHIP_SOMETHING_NEW", "2026-01-04", { reasonDescription: "  padded  " }),
      ]),
      "UTC",
    )
    expect(rows.map((r) => r.quote)).toEqual([null, "Closed for winter", words, "  padded  "])
    expect(rows[2].detail).toBe("Reason: Other. Installed for 2.0 days")
  })

  it("keeps an event type it does not know, shown by its name with what it carries", () => {
    const rows = timelineRows(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-01"),
        ev("APP_CHARGE_DECLINED", "2026-01-02", { planHandle: "pro", amountCents: 2000, state: "DECLINED" }),
        ev("EARNING_SOMETHING", "2026-01-03", { grossCents: 500, netCents: 400, reason: "late_fee" }),
        ev("SOMETHING_ELSE", "2026-01-04"),
        // What the billing screen reports (the older App.events): derive() leaves these out, the timeline keeps them.
        ev("SUBSCRIPTION_CHARGE_DECLINED", "2026-01-05", { amountCents: 2499 }),
      ]),
      "UTC",
    )
    expect(rows.map((r) => ({ type: r.type, title: r.title, detail: r.detail, tone: r.tone }))).toEqual([
      { type: "RELATIONSHIP_INSTALLED", title: "Installed", detail: null, tone: "plain" },
      { type: "APP_CHARGE_DECLINED", title: "App charge declined", detail: "Plan pro. $20. State DECLINED", tone: "plain" },
      { type: "EARNING_SOMETHING", title: "Earning something", detail: "$5 gross, $4 net. Reason: Late fee", tone: "plain" },
      { type: "SOMETHING_ELSE", title: "Something else", detail: null, tone: "plain" },
      { type: "SUBSCRIPTION_CHARGE_DECLINED", title: "Subscription charge declined", detail: "$24.99", tone: "plain" },
    ])
  })

  it("says a subscription Shopify sent between an uninstall and the next install was not counted", () => {
    const rows = timelineRows(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-01T10:00:00Z"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01T11:00:00Z", monthly(1000, null, "basic")),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-05T12:00:00Z"),
        ev("SUBSCRIPTION_UPDATED", "2026-01-05T12:30:00Z", monthly(1000, null, "basic")),
        ev("SUBSCRIPTION_CREATED", "2026-01-06T09:00:00Z", monthly(2000)),
        ev("RELATIONSHIP_INSTALLED", "2026-01-10T09:00:00Z"),
        ev("SUBSCRIPTION_CREATED", "2026-01-10T09:05:00Z", monthly(2000)),
      ]),
      "UTC",
    )
    expect(said(rows)).toEqual([
      { title: "Installed", detail: null },
      { title: "Subscribed", detail: "basic at $10 a month" },
      { title: "Uninstalled", detail: "No reason given. Installed for 4.1 days" },
      { title: "Subscription updated", detail: "basic at $10 a month. Not counted: it came after the uninstall" },
      { title: "Subscribed", detail: "pro at $20 a month. Not counted: it came after the uninstall" },
      { title: "Reinstalled", detail: "Install 2 of this shop" },
      { title: "Subscribed", detail: "pro at $20 a month" },
    ])
  })

  it("says what an update that changed nothing, a subscription first seen in an update, and a plan with no price were", () => {
    expect(
      said(
        timelineRows(
          timelineOf([
            ev("RELATIONSHIP_INSTALLED", "2026-01-01"),
            ev("SUBSCRIPTION_UPDATED", "2026-01-02", monthly(2000)),
            ev("SUBSCRIPTION_UPDATED", "2026-01-05", { ...monthly(2000), trialDaysRemaining: 0 }),
            ev("SUBSCRIPTION_CANCELED", "2026-01-07"),
            ev("SUBSCRIPTION_CREATED", "2026-01-09", { planHandle: "usage", billingPeriod: "EVERY_30_DAYS" }),
            // A plan change with no price keeps the price before it, as derive() counts it.
            ev("SUBSCRIPTION_CREATED", "2026-01-12", monthly(1500, null, "basic")),
            ev("SUBSCRIPTION_UPDATED", "2026-01-20", { planHandle: "plus" }),
          ]),
          "UTC",
        ),
      ),
    ).toEqual([
      { title: "Installed", detail: null },
      { title: "Subscribed", detail: "pro at $20 a month. First seen in an update" },
      { title: "Subscription updated", detail: "pro at $20 a month" },
      { title: "Canceled", detail: null },
      { title: "Subscribed", detail: "usage, with no flat price" },
      { title: "Plan changed", detail: "From usage, with no flat price to basic at $15 a month" },
      { title: "Plan changed", detail: "From basic at $15 a month to plus at $15 a month" },
    ])
  })

  it("falls back to the events alone when the stays and periods are not built", () => {
    const t = { ...timelineOf([]), events: [ev("RELATIONSHIP_INSTALLED", "2026-01-01"), ev("SUBSCRIPTION_CREATED", "2026-01-01", monthly(2000, 7)), ev("SUBSCRIPTION_UPDATED", "2026-01-03", monthly(2500))], eventCount: 3 }
    expect(said(timelineRows(t, "UTC"))).toEqual([
      { title: "Installed", detail: null },
      { title: "Subscribed", detail: "pro at $20 a month" },
      { title: "Subscription updated", detail: "pro at $25 a month" },
    ])
  })

  it("leaves out trial rows older than the first event when the list was cut to the latest events", () => {
    const full = timelineOf(historyA())
    const rows = timelineRows({ ...full, events: full.events.slice(-3) }, "UTC")
    expect(rows.map((r) => r.title)).toEqual(["Plan changed", "Canceled", "Uninstalled"])
    // Uncut, nothing is left out.
    expect(timelineRows(full, "UTC")).toHaveLength(9)
  })
})

describe("where a shop stands now", () => {
  it("is paying, after its trial converted", () => {
    const s = shopStanding(
      timelineOf([
        ev("RELATIONSHIP_INSTALLED", "2026-01-01T10:00:00Z"),
        ev("SUBSCRIPTION_CREATED", "2026-01-01T11:00:00Z", { amountCents: 24000, billingPeriod: "ANNUAL", trialDays: 7, planHandle: "yearly" }),
        ev("RELATIONSHIP_UNINSTALLED", "2026-01-03"),
        ev("RELATIONSHIP_INSTALLED", "2026-01-04T10:00:00Z"),
        ev("SUBSCRIPTION_CREATED", "2026-01-04T11:00:00Z", { amountCents: 24000, billingPeriod: "ANNUAL", trialDays: 7, planHandle: "yearly" }),
      ]),
    )
    expect(s).toEqual({
      installed: true,
      since: new Date("2026-01-04T10:00:00Z"),
      installs: 2,
      firstInstalledAt: new Date("2026-01-01T10:00:00Z"),
      plan: { status: "paying", planHandle: "yearly", billingPeriod: "ANNUAL", monthlyCents: 2000 },
      mrrCents: 2000,
    })
  })

  it("is in a free trial, which adds nothing to MRR yet", () => {
    const s = shopStanding(timelineOf([ev("RELATIONSHIP_INSTALLED", "2026-02-05"), ev("SUBSCRIPTION_CREATED", "2026-02-05", monthly(2000, 14))]))
    expect(s.plan).toEqual({ status: "trial", planHandle: "pro", billingPeriod: "EVERY_30_DAYS", monthlyCents: 2000, trialEndsAt: new Date("2026-02-19T12:00:00Z") })
    expect(s.mrrCents).toBe(0)
  })

  it("is free when installed with no paid plan, on a $0 plan or none", () => {
    expect(shopStanding(timelineOf([ev("RELATIONSHIP_INSTALLED", "2026-01-01"), ev("SUBSCRIPTION_CREATED", "2026-01-02", monthly(0, null, "starter"))])).plan).toEqual({ status: "free", planHandle: "starter" })
    expect(shopStanding(timelineOf([ev("RELATIONSHIP_INSTALLED", "2026-01-01")])).plan).toEqual({ status: "free", planHandle: null })
  })

  it("has left, and pays nothing", () => {
    const s = shopStanding(timelineOf([ev("RELATIONSHIP_INSTALLED", "2026-01-01"), ev("SUBSCRIPTION_CREATED", "2026-01-01", monthly(1000)), ev("RELATIONSHIP_UNINSTALLED", "2026-01-09")]))
    expect(s).toMatchObject({ installed: false, since: new Date("2026-01-09T12:00:00Z"), installs: 1, plan: { status: "none" }, mrrCents: 0 })
  })

  it("reads an uninstall whose install came before the history from the events, and is unknown with neither", () => {
    expect(shopStanding(timelineOf([ev("RELATIONSHIP_UNINSTALLED", "2026-01-04")]))).toEqual({
      installed: false,
      since: new Date("2026-01-04T12:00:00Z"),
      installs: 0,
      firstInstalledAt: null,
      plan: { status: "none" },
      mrrCents: 0,
    })
    expect(shopStanding(timelineOf([ev("CHARGE_RECURRING", "2026-01-04", { amountCents: 1000 })]))).toMatchObject({ installed: null, since: null, installs: 0, plan: { status: "none" } })
  })
})

describe("uninstall reasons as words", () => {
  it("splits Shopify's list and leaves out empty parts", () => {
    expect(reasonsLabel("app_not_working, too_expensive")).toBe("App not working, Too expensive")
    expect(reasonsLabel(" , ")).toBeNull()
    expect(reasonsLabel(null)).toBeNull()
  })
})

describe("the shop in the URL", () => {
  it("is a lowercased, trimmed domain", () => {
    expect(parseShopParam("demo-shop-12.myshopify.com")).toBe("demo-shop-12.myshopify.com")
    expect(parseShopParam("  Demo-Shop.MyShopify.COM ")).toBe("demo-shop.myshopify.com")
    expect(parseShopParam("demo%2Dshop.myshopify.com")).toBe("demo-shop.myshopify.com")
    expect(parseShopParam("%20demo.myshopify.com%20")).toBe("demo.myshopify.com")
  })

  it("is null for anything that does not look like a shop domain", () => {
    for (const bad of ["", "   ", "demo", "%E0%A4%A", "../etc/passwd", "a b.myshopify.com", "shop.myshopify.com/x", "shop_1.myshopify.com", "-shop.myshopify.com", "shop..myshopify.com", "shop.myshopify.com.", "shöp.myshopify.com", "%00shop.myshopify.com"]) {
      expect(parseShopParam(bad), bad).toBeNull()
    }
    expect(parseShopParam(`${"a".repeat(252)}.com`)).toBeNull()
    expect(parseShopParam(`${"a".repeat(240)}.myshopify.com`)).toBe(`${"a".repeat(240)}.myshopify.com`)
    expect(parseShopParam("a".repeat(2000))).toBeNull()
  })
})
