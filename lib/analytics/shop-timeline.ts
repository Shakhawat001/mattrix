import { and, asc, desc, eq, sql } from "drizzle-orm"
import type { Queryable } from "@/lib/db/client"
import { events, installs, subscriptions, trials } from "@/lib/db/schema"
import { rankOf, type SubscriptionRow, type TrialRow } from "./derive"
import { getLedgerCutoff, shownRows } from "./earnings"

// Everything stored about one shop in one app: its stays, its subscription periods, its trials,
// and the raw events they were built from, each oldest first. Of the earnings rows it lists only the
// ones the app's numbers count (earnings.ts): ledger transactions up to the app's ledger cutoff and
// earning events after it, so a sale is not told twice. The event log still shows every row.

const DEFAULT_MAX_EVENTS = 1000
const MOST_EVENTS = 10_000

/** One stay: from an install to its uninstall, or still open. */
export type TimelineStay = {
  /** 1 for the first install, 2 for the first reinstall, and so on. */
  seq: number
  installedAt: Date
  uninstalledAt: Date | null
  /** The reason codes Shopify sent with the uninstall, comma separated. */
  reason: string | null
  /** The merchant's own words on leaving. Written by the merchant: untrusted text. */
  reasonDescription: string | null
}

/** One period on one plan at one price, as derive() wrote it. */
export type TimelineSubscription = {
  startedAt: Date
  endedAt: Date | null
  endReason: SubscriptionRow["endReason"]
  /** new, change (a plan change) or resume (unfrozen). */
  kind: SubscriptionRow["kind"]
  /** The price per month, a yearly price divided by twelve. Zero for a free plan. */
  monthlyCents: number
  previousMonthlyCents: number | null
  planHandle: string | null
  billingPeriod: string | null
  /** The end of the free trial this period began in, if any. */
  trialEndsAt: Date | null
  /** When that trial turned into money. A period with a trial and no conversion never paid. */
  convertedAt: Date | null
}

export type TimelineTrial = {
  startedAt: Date
  endsAt: Date
  trialDays: number
  resolvedAt: Date | null
  outcome: TrialRow["outcome"]
}

/** One event as Shopify sent it. */
export type TimelineEvent = {
  /** Shopify's own event id. */
  id: string
  /** RELATIONSHIP_INSTALLED, SUBSCRIPTION_CREATED, CHARGE_RECURRING, EARNING_REFUND, ... */
  type: string
  occurredAt: Date
  /** The state Shopify reported with the event, such as INSTALLED or ACTIVE. */
  state: string | null
  planHandle: string | null
  billingPeriod: string | null
  trialDays: number | null
  /** Trial days the merchant had left when the event happened. */
  trialDaysRemaining: number | null
  /** When a canceled subscription ends, if Shopify gave a date: the start of that UTC day. */
  cancelEffectiveOn: Date | null
  /** The plan price or the charge, in cents. */
  amountCents: number | null
  currency: string | null
  /** Earnings, in cents: before Shopify's fee, after it, and the fee. */
  grossCents: number | null
  netCents: number | null
  feeCents: number | null
  /** The reason codes Shopify sent with an uninstall, comma separated. */
  reason: string | null
  /** The merchant's own words on leaving. Written by the merchant: untrusted text. */
  reasonDescription: string | null
}

export type ShopTimeline = {
  appId: string
  /** The shop's myshopify.com domain. */
  shop: string
  stays: TimelineStay[]
  subscriptions: TimelineSubscription[]
  trials: TimelineTrial[]
  /** The shop's latest events, at most `maxEvents` of them, oldest first. */
  events: TimelineEvent[]
  /** How many events the shop has in all. More than `events.length` when the list was cut. */
  eventCount: number
}

/**
 * One shop's history in one app, or null when the app has no events for that shop. The shop is
 * its myshopify.com domain, matched without regard to case or surrounding spaces. `maxEvents`
 * (1000 unless given, at most 10,000) caps the event list, keeping the latest; the derived lists
 * are never cut.
 */
export async function getShopTimeline(db: Queryable, appId: string, shop: string, options: { maxEvents?: number } = {}): Promise<ShopTimeline | null> {
  const domain = shop.trim().toLowerCase()
  if (!domain) return null
  const asked = options.maxEvents
  const limit = asked !== undefined && Number.isFinite(asked) ? Math.min(MOST_EVENTS, Math.max(1, Math.floor(asked))) : DEFAULT_MAX_EVENTS

  const ofShop = and(eq(events.appId, appId), eq(events.shop, domain), shownRows(await getLedgerCutoff(db, appId)))
  const [[count], eventRows, stays, subs, trialRows] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(events).where(ofShop),
    db
      .select({
        id: events.id,
        type: events.type,
        occurredAt: events.occurredAt,
        state: events.state,
        planHandle: events.planHandle,
        billingPeriod: events.billingPeriod,
        trialDays: events.trialDays,
        trialDaysRemaining: events.trialDaysRemaining,
        cancelEffectiveOn: events.cancelEffectiveOn,
        amountCents: events.amountCents,
        currency: events.currency,
        grossCents: events.grossCents,
        netCents: events.netCents,
        feeCents: events.feeCents,
        reason: events.reason,
        reasonDescription: events.reasonDescription,
      })
      .from(events)
      .where(ofShop)
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit),
    db
      .select({ seq: installs.seq, installedAt: installs.installedAt, uninstalledAt: installs.uninstalledAt, reason: installs.reason, reasonDescription: installs.reasonDescription })
      .from(installs)
      .where(and(eq(installs.appId, appId), eq(installs.shop, domain)))
      .orderBy(asc(installs.installedAt), asc(installs.seq)),
    db
      .select({
        startedAt: subscriptions.startedAt,
        endedAt: subscriptions.endedAt,
        endReason: subscriptions.endReason,
        kind: subscriptions.kind,
        monthlyCents: subscriptions.monthlyCents,
        previousMonthlyCents: subscriptions.previousMonthlyCents,
        planHandle: subscriptions.planHandle,
        billingPeriod: subscriptions.billingPeriod,
        trialEndsAt: subscriptions.trialEndsAt,
        convertedAt: subscriptions.convertedAt,
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.appId, appId), eq(subscriptions.shop, domain)))
      // Periods follow one another, so this is the order they happened in; an open one is last.
      .orderBy(asc(subscriptions.startedAt), sql`${subscriptions.endedAt} ASC NULLS LAST`),
    db
      .select({ startedAt: trials.startedAt, endsAt: trials.endsAt, trialDays: trials.trialDays, resolvedAt: trials.resolvedAt, outcome: trials.outcome })
      .from(trials)
      .where(and(eq(trials.appId, appId), eq(trials.shop, domain)))
      .orderBy(asc(trials.startedAt)),
  ])

  // A shop whose only rows are earnings the app's numbers do not count still has a timeline.
  if (eventRows.length === 0) {
    const [any] = await db.select({ one: sql<number>`1` }).from(events).where(and(eq(events.appId, appId), eq(events.shop, domain))).limit(1)
    if (!any) return null
  }

  return {
    appId,
    shop: domain,
    stays,
    subscriptions: subs.map((s) => ({ ...s, endReason: s.endReason as SubscriptionRow["endReason"], kind: s.kind as SubscriptionRow["kind"] })),
    trials: trialRows.map((t) => ({ ...t, outcome: t.outcome as TrialRow["outcome"] })),
    // Events on the same instant in the order derive() reads them: by its rank, then by id.
    events: eventRows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || rankOf(a.type) - rankOf(b.type) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    // Counted in a query of its own; a sync landing between the two must not make it smaller than the list.
    eventCount: Math.max(count?.n ?? 0, eventRows.length),
  }
}
