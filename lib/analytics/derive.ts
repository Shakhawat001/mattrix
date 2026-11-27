import { EVENT, LEGACY_EVENT_TYPES, TRANSACTION_TYPES } from "@/lib/partner/query"
import { dayIn, startOfDay } from "@/lib/time-zone"
import { addDays } from "./range"

// Turns one app's raw events into the facts the dashboard is built on. Pure: events, a
// clock and the dashboard's time zone in, rows out, no database. tests/derive.test.ts pins every definition.
//
// What it makes:
//   installs        one stay per install of a shop: installed, then uninstalled or still open
//   subscriptions   one period per shop per plan and price (a plan change starts a new one)
//   trials          what became of each free trial
//   daily           one row per day in the dashboard's time zone: what happened that day, and the
//                   stock at the end of it
//
// Where Shopify's events leave a choice, the choice is made here and written down. The main ones:
//
//   - MRR and subscribers count paying shops only. A free trial is tracked on its own and
//     becomes MRR when it converts, which is the usual SaaS definition (ChartMogul, Baremetrics
//     and Stripe all leave trials out of MRR).
//   - A trial converts when it ends with the subscription still open. Shopify bills app charges
//     on the merchant's own invoice date, which can be weeks after the trial ended, so the charge
//     event is not waited for; an earlier charge converts it earlier.
//   - A cancellation counts on the day it takes effect: the start of the `cancelEffectiveOn` day
//     (in the dashboard's time zone) when Shopify gives a later date, otherwise the moment of the
//     event. The period keeps when the cancel was first scheduled and the day it takes effect, so a
//     subscription set to end can be listed until then.
//   - Subscription events carry no subscription id, so a plan change has to be recognized: a
//     second subscription while one is open, a cancel (or a scheduled cancel) naming another plan
//     moments after a new one began, or a cancel followed within minutes by a new subscription are
//     all one plan change.
//   - A loss has one of two causes. A freeze, or a cancel or an uninstall while Shopify has the
//     store's billing account deactivated (closed, paused or unpaid: a deactivation since its latest
//     install, with no reactivation since), is the store going inactive. Anything else is the
//     merchant leaving.
//   - Shopify cancels an app's subscriptions when the app is uninstalled, so a creation, an update or
//     an unfreeze between a shop's uninstall and its next install (Shopify can send one late) is
//     counted and otherwise ignored. A shop with no install or uninstall seen yet installed before
//     the history starts, so its subscription events count as usual.
//   - Earnings come from Shopify's payout ledger (its transactions) as far as it has been read, and
//     from the earning events after that. Only the ledger's net is what reached the payout, after the
//     2.9% processing fee and any regulatory operating fee as well as the revenue share; an earning
//     event's net is after the revenue share only. The ledger is used up to its watermark (how far
//     the sync has read it), so a ledger read only partly never leaves later days empty, and each
//     moment has one source, so a charge is not counted twice. In steady state the watermark is the
//     last sync, so every earning comes from the ledger. An app with no ledger transaction read yet
//     takes all its earnings from the earning events.

/**
 * The version of these rules. Each app stores the version its derived tables were built with, and
 * the worker rebuilds any app built with an older one, so a deploy that changes a rule recomputes
 * all of history. Bump it with every change to what derive() returns.
 */
export const DERIVE_VERSION = 8

const DAY_MS = 86_400_000
/** A cancel and a new subscription this close together are one plan change, not a loss and a new sale. */
const REPLACE_WINDOW_MS = 10 * 60_000
/** What merchants did on the billing screen (the older App.events). Counted on their own, never replayed here. */
const BILLING_SCREEN_TYPES: ReadonlySet<string> = new Set(LEGACY_EVENT_TYPES)
/** Shopify's payout ledger: sales, credits and adjustments. Money only, never replayed here. */
export const LEDGER_TYPES: ReadonlySet<string> = new Set(TRANSACTION_TYPES)

/**
 * A ledger transaction's gross and net, with one sign. Its net is what was added to or taken off
 * the payout, so its sign is the transaction's: a sale adds, a credit or an adjustment usually takes
 * off. The gross takes that sign too, whichever sign Shopify gave it, so the fees (gross minus net)
 * of a credit or a refund come out negative by whatever part of its fees Shopify handed back.
 */
export function ledgerMoney(e: { grossCents: number | null; netCents: number | null }): { grossCents: number; netCents: number } {
  const net = e.netCents ?? 0
  const gross = Math.abs(e.grossCents ?? net)
  return { grossCents: net < 0 ? -gross : net > 0 ? gross : 0, netCents: net }
}

/**
 * The moment up to which an app's earnings come from the payout ledger: how far the ledger has been
 * read, when the app has a ledger transaction by then. Null when it has none, so its earnings come
 * from the earning events alone (a token without View financials, a pass that has not read anything
 * yet, or an app that has never sold anything).
 */
export function ledgerCutoff(events: { type: string; occurredAt: Date }[], ledgerReadUntil: Date | null): Date | null {
  if (!ledgerReadUntil) return null
  const until = ledgerReadUntil.getTime()
  return events.some((e) => LEDGER_TYPES.has(e.type) && e.occurredAt.getTime() <= until) ? ledgerReadUntil : null
}

/**
 * Does this row count toward gross, fees and net earnings, given the app's cutoff? Ledger
 * transactions up to the cutoff, earning events after it; with no cutoff, the earning events alone.
 */
export function countsAsEarning(e: { type: string; occurredAt: Date }, cutoff: Date | null): boolean {
  if (LEDGER_TYPES.has(e.type)) return cutoff !== null && e.occurredAt.getTime() <= cutoff.getTime()
  if (e.type.startsWith("EARNING_")) return cutoff === null || e.occurredAt.getTime() > cutoff.getTime()
  return false
}

export type RawEvent = {
  type: string
  occurredAt: Date
  shop: string | null
  reason: string | null
  reasonDescription: string | null
  planHandle: string | null
  billingPeriod: string | null
  trialDays: number | null
  /** Trial days left when the event happened. Shorter than trialDays for a merchant who used part of a trial before. */
  trialDaysRemaining: number | null
  /** When a canceled subscription actually ends, if Shopify gives a date. */
  cancelEffectiveOn: Date | null
  amountCents: number | null
  grossCents: number | null
  netCents: number | null
  feeCents: number | null
}

export type InstallRow = {
  shop: string
  seq: number
  installedAt: Date
  uninstalledAt: Date | null
  reason: string | null
  reasonDescription: string | null
}

export type SubscriptionRow = {
  shop: string
  startedAt: Date
  endedAt: Date | null
  endReason: "canceled" | "uninstalled" | "frozen" | "replaced" | null
  kind: "new" | "change" | "resume"
  monthlyCents: number
  previousMonthlyCents: number | null
  planHandle: string | null
  billingPeriod: string | null
  /** The end of the trial this period belongs to, if it began during one. */
  trialEndsAt: Date | null
  /** When that trial turned into money. A period with a trial and no conversion never paid. */
  convertedAt: Date | null
  /** When Shopify first said this period is canceled from a later day. Null when no cancel was scheduled. */
  cancelScheduledAt: Date | null
  /** The start of that day in the dashboard's time zone. The period pays until then, and ends then unless something ends it first. */
  cancelEffectiveAt: Date | null
}

export type TrialRow = {
  shop: string
  startedAt: Date
  endsAt: Date
  trialDays: number
  resolvedAt: Date | null
  outcome: "converted" | "canceled" | "open"
}

export type DailyRow = {
  date: string
  installs: number
  reinstalls: number
  uninstalls: number
  newSubs: number
  canceledSubs: number
  trialsStarted: number
  trialsConverted: number
  trialsCanceled: number
  newMrrCents: number
  expansionMrrCents: number
  contractionMrrCents: number
  churnedMrrCents: number
  chargedCents: number
  grossEarnedCents: number
  netEarnedCents: number
  feeCents: number
  refundedCents: number
  creditCents: number
  /** Times Shopify deactivated a store's billing account (closed, paused or unpaid), and reactivated one. */
  deactivations: number
  reactivations: number
  /** The parts of uninstalls, canceledSubs and churnedMrrCents that were the store going inactive (lostToInactiveStore). */
  uninstallsStoreInactive: number
  canceledSubsStoreInactive: number
  churnedMrrStoreInactiveCents: number
  activeInstalls: number
  /** Paying subscribers. */
  activeSubs: number
  /** Subscriptions still in their free trial. */
  trialSubs: number
  /** Paying MRR. */
  mrrCents: number
  /** What the running trials would add to MRR if they all converted. */
  trialMrrCents: number
}

export type Derived = {
  installs: InstallRow[]
  subscriptions: SubscriptionRow[]
  trials: TrialRow[]
  daily: DailyRow[]
  /** Uninstalls whose install was never seen (before the backfill, or an event Shopify did not send). */
  orphanUninstalls: number
  /** Subscription creations, updates and unfreezes between a shop's uninstall and its next install: ignored, since an uninstall cancels the app's subscriptions. */
  ignoredAfterUninstall: number
  /** Up to when earnings came from the payout ledger (ledgerCutoff()). Readers of earnings outside the rollup follow it. */
  ledgerUntil: Date | null
}

/** A yearly price spread over twelve months. Anything else is taken as one month. */
export function monthlyCents(amountCents: number | null, billingPeriod: string | null): number | null {
  if (amountCents === null) return null
  return billingPeriod === "ANNUAL" ? Math.round(amountCents / 12) : amountCents
}

// On the same instant: the install first, then a deactivation (so what comes with it counts as the
// store going inactive), then a cancel (so a cancel and a new subscription at the same moment read
// as a plan change), then what a subscription does, charges, the endings, and a reactivation last.
const RANK: Record<string, number> = {
  RELATIONSHIP_INSTALLED: 0,
  RELATIONSHIP_DEACTIVATED: 1,
  SUBSCRIPTION_CANCELED: 2,
  SUBSCRIPTION_CREATED: 3,
  SUBSCRIPTION_UPDATED: 3,
  SUBSCRIPTION_UNFROZEN: 3,
  SUBSCRIPTION_FROZEN: 5,
  RELATIONSHIP_UNINSTALLED: 6,
  RELATIONSHIP_REACTIVATED: 7,
}
/** An event's place among events on the same instant. The shop timeline orders its events by it too. */
export const rankOf = (type: string) => RANK[type] ?? 4

type TrialRef = { endsAt: Date; convertedAt: Date | null }
type Trial = { row: TrialRow; ref: TrialRef }
type Period = SubscriptionRow & { ref: TrialRef | null; endedWhileDeactivated: boolean }
type ShopState = {
  install: InstallRow | null
  installCount: number
  sub: Period | null
  lastMonthly: number
  lastPlan: string | null
  lastBilling: string | null
  trial: Trial | null
  /** The last period that ended in a cancel, and the trial it ended, in case a new subscription follows at once. */
  lastCancel: { period: Period; at: Date; trial: Trial | null } | null
  /** Shopify deactivated the store's billing account after its latest install, and has not reactivated it since. */
  deactivated: boolean
  /** An uninstall was seen and no install since: the shop does not have the app. */
  uninstalled: boolean
}

/** Does the event name the plan this period is on? An event that names no plan cannot be told apart, so it counts as a match. */
function namesSamePlan(p: Period, e: RawEvent): boolean {
  if (e.planHandle && p.planHandle) return e.planHandle === p.planHandle && (!e.billingPeriod || !p.billingPeriod || e.billingPeriod === p.billingPeriod)
  const monthly = monthlyCents(e.amountCents, e.billingPeriod)
  return monthly === null || monthly === p.monthlyCents
}

/** Does an update move the shop to a different plan or price? */
function changesPlan(p: Period, e: RawEvent): boolean {
  const monthly = monthlyCents(e.amountCents, e.billingPeriod)
  return (
    (e.planHandle !== null && e.planHandle !== p.planHandle) ||
    (e.billingPeriod !== null && e.billingPeriod !== p.billingPeriod) ||
    (monthly !== null && monthly !== p.monthlyCents)
  )
}

/** A cancel that takes effect on a later day. A later one moves the day; the time it was scheduled stays the first. */
function scheduleCancel(p: Period, at: Date, effective: Date) {
  p.cancelScheduledAt ??= at
  p.cancelEffectiveAt = effective
}

/** `ledgerReadUntil`: how far the sync has read the app's payout ledger (its connection's watermark for it), or null. */
export function derive(events: RawEvent[], now: Date, timeZone: string, ledgerReadUntil: Date | null = null): Derived {
  /**
   * Shopify's cancelEffectiveOn is a date with no time ("2026-02-10"), stored as midnight UTC of it.
   * The cancellation takes effect as that day begins where the dashboard counts days, so it
   * lands on the day Shopify names in any zone.
   */
  const startOfNamedDay = (date: Date) => startOfDay(date.toISOString().slice(0, 10), timeZone)

  // By time, then by event type (RANK), then in the order given: rebuildApp reads events by time
  // and then by id, so two events of the same rank at the same instant are always read alike.
  const sorted = events
    .filter((e) => !BILLING_SCREEN_TYPES.has(e.type))
    .map((e, index) => ({ e, index }))
    .sort((a, b) => a.e.occurredAt.getTime() - b.e.occurredAt.getTime() || rankOf(a.e.type) - rankOf(b.e.type) || a.index - b.index)
    .map(({ e }) => e)

  const installs: InstallRow[] = []
  const periods: Period[] = []
  const trials: TrialRow[] = []
  const uninstallDates: Date[] = []
  const inactiveUninstallDates: Date[] = []
  const moneyEvents: RawEvent[] = []
  const shops = new Map<string, ShopState>()
  let orphanUninstalls = 0
  let ignoredAfterUninstall = 0

  const stateOf = (shop: string): ShopState => {
    let s = shops.get(shop)
    if (!s) shops.set(shop, (s = { install: null, installCount: 0, sub: null, lastMonthly: 0, lastPlan: null, lastBilling: null, trial: null, lastCancel: null, deactivated: false, uninstalled: false }))
    return s
  }

  function endTrial(s: ShopState, at: Date, outcome: "converted" | "canceled") {
    if (!s.trial) return
    s.trial.row.outcome = outcome
    s.trial.row.resolvedAt = at
    if (outcome === "converted") s.trial.ref.convertedAt = at
    s.trial = null
  }

  function closePeriod(s: ShopState, at: Date, reason: NonNullable<SubscriptionRow["endReason"]>) {
    if (!s.sub) return
    const period = s.sub
    period.endedAt = at
    period.endReason = reason
    period.endedWhileDeactivated = s.deactivated
    s.lastMonthly = period.monthlyCents
    s.lastPlan = period.planHandle
    s.lastBilling = period.billingPeriod
    s.sub = null
    s.lastCancel = reason === "canceled" ? { period, at, trial: s.trial } : null
    // A subscription that ends for good before its trial turned into money ends the trial too.
    if (reason !== "replaced") endTrial(s, at, "canceled")
  }

  function openPeriod(s: ShopState, e: RawEvent, kind: SubscriptionRow["kind"]): Period {
    const shop = e.shop as string
    const monthly = monthlyCents(e.amountCents, e.billingPeriod) ?? (kind === "new" ? 0 : s.lastMonthly)
    const period: Period = {
      shop,
      startedAt: e.occurredAt,
      endedAt: null,
      endReason: null,
      kind,
      monthlyCents: monthly,
      previousMonthlyCents: kind === "change" ? s.lastMonthly : null,
      planHandle: e.planHandle ?? (kind === "new" ? null : s.lastPlan),
      billingPeriod: e.billingPeriod ?? (kind === "new" ? null : s.lastBilling),
      trialEndsAt: null,
      convertedAt: null,
      cancelScheduledAt: null,
      cancelEffectiveAt: null,
      // A trial in progress carries over to the new plan.
      ref: s.trial?.ref ?? null,
      endedWhileDeactivated: false,
    }
    periods.push(period)
    s.sub = period
    s.lastMonthly = monthly
    s.lastPlan = period.planHandle
    s.lastBilling = period.billingPeriod
    return period
  }

  /**
   * What a subscription event says about the free trial. `mayStart`: the event began a subscription,
   * so it may begin a trial. `nominal`: when Shopify gives no days remaining, the plan's trial length
   * stands in (only for a creation, where the two are the same for a first-time merchant).
   */
  function applyTrial(s: ShopState, e: RawEvent, mayStart: boolean, nominal: boolean) {
    const remaining = e.trialDaysRemaining ?? (nominal ? e.trialDays : null)
    if (remaining === null || !s.sub) return
    if (s.trial) {
      if (remaining > 0) {
        const endsAt = new Date(e.occurredAt.getTime() + remaining * DAY_MS)
        s.trial.row.endsAt = endsAt
        s.trial.ref.endsAt = endsAt
      } else {
        // No trial days left on the plan now in force: billing has started.
        endTrial(s, e.occurredAt, "converted")
      }
    } else if (mayStart && remaining > 0) {
      const endsAt = new Date(e.occurredAt.getTime() + remaining * DAY_MS)
      const row: TrialRow = { shop: s.sub.shop, startedAt: e.occurredAt, endsAt, trialDays: remaining, resolvedAt: null, outcome: "open" }
      trials.push(row)
      s.trial = { row, ref: { endsAt, convertedAt: null } }
      s.sub.ref = s.trial.ref
    }
  }

  /** A subscription created, or updated with nothing open: a new one, a plan change, or the second half of one. */
  function subscribe(s: ShopState, e: RawEvent) {
    const recent = s.lastCancel && e.occurredAt.getTime() - s.lastCancel.at.getTime() <= REPLACE_WINDOW_MS ? s.lastCancel : null
    if (s.sub) {
      closePeriod(s, e.occurredAt, "replaced")
      openPeriod(s, e, "change")
    } else if (recent) {
      // Canceled moments ago and subscribed again: one plan change. The old period hands over
      // at this moment, and a trial it had ended goes on.
      recent.period.endReason = "replaced"
      recent.period.endedAt = e.occurredAt
      if (recent.trial) {
        recent.trial.row.outcome = "open"
        recent.trial.row.resolvedAt = null
        s.trial = recent.trial
      }
      openPeriod(s, e, "change")
    } else {
      openPeriod(s, e, "new")
    }
    s.lastCancel = null
  }

  /**
   * Brings a shop up to `t`: a trial that reached its end with the subscription open converts,
   * and a cancellation that took effect ends the period. Whichever comes first happens first.
   */
  function settle(s: ShopState, t: Date) {
    for (;;) {
      const conversion = s.trial && s.sub ? s.trial.row.endsAt : null
      const end = s.sub?.cancelEffectiveAt ?? null
      if (end && end.getTime() <= t.getTime() && (!conversion || end.getTime() <= conversion.getTime())) {
        closePeriod(s, end, "canceled")
        s.lastCancel = null
        continue
      }
      if (conversion && conversion.getTime() <= t.getTime()) {
        endTrial(s, conversion, "converted")
        continue
      }
      return
    }
  }

  for (const e of sorted) {
    const isMoney = e.type.startsWith("CHARGE_") || e.type.startsWith("EARNING_") || e.type.startsWith("CREDIT_") || LEDGER_TYPES.has(e.type)
    if (isMoney) moneyEvents.push(e)
    // A ledger transaction says what reached the payout, nothing about installs or subscriptions.
    if (LEDGER_TYPES.has(e.type)) continue
    if (e.type === EVENT.UNINSTALLED) uninstallDates.push(e.occurredAt)
    if (!e.shop) {
      if (e.type === EVENT.UNINSTALLED) orphanUninstalls++
      continue
    }
    const s = stateOf(e.shop)
    settle(s, e.occurredAt)

    // The shop uninstalled and has not installed again, so it has no subscription to open, change or resume.
    if (s.uninstalled && (e.type === EVENT.SUB_CREATED || e.type === EVENT.SUB_UPDATED || e.type === EVENT.SUB_UNFROZEN)) {
      ignoredAfterUninstall++
      continue
    }

    switch (e.type) {
      case EVENT.INSTALLED:
        // An install means the store is active, whatever Shopify said about it before.
        s.deactivated = false
        s.uninstalled = false
        if (!s.install) {
          s.installCount++
          const row: InstallRow = { shop: e.shop, seq: s.installCount, installedAt: e.occurredAt, uninstalledAt: null, reason: null, reasonDescription: null }
          installs.push(row)
          s.install = row
        }
        break

      case EVENT.DEACTIVATED:
        s.deactivated = true
        break

      case EVENT.REACTIVATED:
        s.deactivated = false
        break

      case EVENT.UNINSTALLED:
        if (s.deactivated) inactiveUninstallDates.push(e.occurredAt)
        if (s.install) {
          s.install.uninstalledAt = e.occurredAt
          s.install.reason = e.reason
          s.install.reasonDescription = e.reasonDescription
          s.install = null
        } else {
          orphanUninstalls++
        }
        // Uninstalling takes the subscription with it, and any trial.
        closePeriod(s, e.occurredAt, "uninstalled")
        s.lastCancel = null
        s.uninstalled = true
        break

      case EVENT.SUB_CREATED:
        subscribe(s, e)
        applyTrial(s, e, true, true)
        break

      case EVENT.SUB_UPDATED: {
        // With nothing open, the creation was missed (before the history starts): this begins it.
        const opens = !s.sub
        if (opens) subscribe(s, e)
        else if (s.sub && changesPlan(s.sub, e)) {
          closePeriod(s, e.occurredAt, "replaced")
          openPeriod(s, e, "change")
        }
        applyTrial(s, e, opens, false)
        break
      }

      case EVENT.SUB_CANCELED: {
        if (!s.sub) break
        // A cancel naming another plan, moments after a new one began, is the old subscription being replaced.
        if (!namesSamePlan(s.sub, e) && e.occurredAt.getTime() - s.sub.startedAt.getTime() <= REPLACE_WINDOW_MS) break
        const effective = e.cancelEffectiveOn ? startOfNamedDay(e.cancelEffectiveOn) : null
        if (effective && effective.getTime() > e.occurredAt.getTime()) scheduleCancel(s.sub, e.occurredAt, effective)
        else closePeriod(s, e.occurredAt, "canceled")
        break
      }

      case EVENT.SUB_CANCELLATION_SCHEDULED: {
        if (!s.sub || !e.cancelEffectiveOn) break
        // As with a cancel: one naming another plan, moments after a new one began, is for the plan it replaced.
        if (!namesSamePlan(s.sub, e) && e.occurredAt.getTime() - s.sub.startedAt.getTime() <= REPLACE_WINDOW_MS) break
        const effective = startOfNamedDay(e.cancelEffectiveOn)
        if (effective.getTime() > e.occurredAt.getTime()) scheduleCancel(s.sub, e.occurredAt, effective)
        else closePeriod(s, e.occurredAt, "canceled")
        break
      }

      case EVENT.SUB_FROZEN:
        closePeriod(s, e.occurredAt, "frozen")
        s.lastCancel = null
        break

      case EVENT.SUB_UNFROZEN:
        if (!s.sub) openPeriod(s, { ...e, amountCents: null }, "resume")
        break

      case EVENT.CHARGE_RECURRING:
        // A real charge before the trial's end turns it into money then.
        if ((e.amountCents ?? 0) > 0 && s.trial && s.sub) endTrial(s, e.occurredAt, "converted")
        break
    }
  }

  // Up to now: trials that have ended convert, cancellations that have taken effect end.
  for (const s of shops.values()) settle(s, now)

  // Listed field by field, so nothing used only while working (the trial reference, the store's state) is stored.
  const subscriptions: SubscriptionRow[] = periods.map((p) => ({
    shop: p.shop,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    endReason: p.endReason,
    kind: p.kind,
    monthlyCents: p.monthlyCents,
    previousMonthlyCents: p.previousMonthlyCents,
    planHandle: p.planHandle,
    billingPeriod: p.billingPeriod,
    trialEndsAt: p.ref?.endsAt ?? null,
    convertedAt: p.ref?.convertedAt ?? null,
    cancelScheduledAt: p.cancelScheduledAt,
    cancelEffectiveAt: p.cancelEffectiveAt,
  }))

  const ledgerUntil = ledgerCutoff(moneyEvents, ledgerReadUntil)
  return {
    installs,
    subscriptions,
    trials,
    daily: buildDaily({ sorted, installs, periods, trials, uninstallDates, inactiveUninstallDates, moneyEvents, ledgerUntil, now, timeZone }),
    orphanUninstalls,
    ignoredAfterUninstall,
    ledgerUntil,
  }
}

// ---------------------------------------------------------------------------
// Daily rollup
// ---------------------------------------------------------------------------

/** When a period starts paying: its start, or its trial's conversion. Null when it never pays. */
function paidFrom(p: Period): number | null {
  if (p.monthlyCents <= 0) return null
  const from = p.ref ? (p.ref.convertedAt ? Math.max(p.startedAt.getTime(), p.ref.convertedAt.getTime()) : null) : p.startedAt.getTime()
  if (from === null || (p.endedAt && from >= p.endedAt.getTime())) return null
  return from
}

/**
 * A lost period was the store going inactive (closed, paused or unpaid) when a freeze ended it, or a
 * cancel or an uninstall while Shopify had the store deactivated. Any other end, a move to a free
 * plan included, was the merchant leaving.
 */
const lostToInactiveStore = (p: Period) => p.endReason === "frozen" || ((p.endReason === "canceled" || p.endReason === "uninstalled") && p.endedWhileDeactivated)

function buildDaily(input: {
  sorted: RawEvent[]
  installs: InstallRow[]
  periods: Period[]
  trials: TrialRow[]
  uninstallDates: Date[]
  /** The uninstalls of stores Shopify had deactivated. */
  inactiveUninstallDates: Date[]
  moneyEvents: RawEvent[]
  /** Up to when earnings come from the payout ledger (ledgerCutoff()). */
  ledgerUntil: Date | null
  now: Date
  timeZone: string
}): DailyRow[] {
  const { sorted, installs, periods, trials, uninstallDates, inactiveUninstallDates, moneyEvents, ledgerUntil, now, timeZone } = input
  if (sorted.length === 0) return []

  // Every day from the first event's to today's. An event after now goes on the last day.
  const days = [dayIn(sorted[0].occurredAt, timeZone)]
  const today = dayIn(now, timeZone)
  for (let d = addDays(days[0], 1); d <= today; d = addDays(d, 1)) days.push(d)
  const length = days.length
  // Where each day starts. A day is not always 24 hours long (daylight saving), so an instant
  // finds its day by searching these, which are the same boundaries the queries use.
  const starts = days.map((d) => startOfDay(d, timeZone).getTime())
  const at = (ms: number) => {
    let lo = 0
    let hi = length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= ms) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const series = () => new Array<number>(length).fill(0)

  // Flows: what happened on each day.
  const f = {
    installs: series(), reinstalls: series(), uninstalls: series(),
    newSubs: series(), canceledSubs: series(),
    trialsStarted: series(), trialsConverted: series(), trialsCanceled: series(),
    newMrr: series(), expansion: series(), contraction: series(), churned: series(),
    charged: series(), gross: series(), net: series(), fee: series(), refunded: series(), credit: series(),
    deactivations: series(), reactivations: series(), uninstallsInactive: series(), canceledInactive: series(), churnedInactive: series(),
  }
  // Stocks as running changes: +1 on the day a thing starts, -1 on the day it ends.
  const s = { installs: series(), subs: series(), mrr: series(), trialSubs: series(), trialMrr: series() }

  for (const i of installs) {
    f.installs[at(i.installedAt.getTime())]++
    if (i.seq > 1) f.reinstalls[at(i.installedAt.getTime())]++
    s.installs[at(i.installedAt.getTime())]++
    if (i.uninstalledAt) s.installs[at(i.uninstalledAt.getTime())]--
  }
  for (const d of uninstallDates) f.uninstalls[at(d.getTime())]++
  for (const d of inactiveUninstallDates) f.uninstallsInactive[at(d.getTime())]++
  for (const e of sorted) {
    if (e.type === EVENT.DEACTIVATED) f.deactivations[at(e.occurredAt.getTime())]++
    else if (e.type === EVENT.REACTIVATED) f.reactivations[at(e.occurredAt.getTime())]++
  }

  // A shop's periods in order, so a plan change can look at the period before and after it.
  const byShop = new Map<string, Period[]>()
  for (const p of periods) {
    const list = byShop.get(p.shop)
    if (list) list.push(p)
    else byShop.set(p.shop, [p])
  }

  for (const list of byShop.values()) {
    list.forEach((p, i) => {
      const from = paidFrom(p)
      const start = p.startedAt.getTime()

      // The part of the period spent in a free trial.
      if (p.monthlyCents > 0 && p.ref) {
        const trialEnd = from ?? p.endedAt?.getTime() ?? null
        if (trialEnd === null || trialEnd > start) {
          s.trialSubs[at(start)]++
          s.trialMrr[at(start)] += p.monthlyCents
          if (trialEnd !== null) {
            s.trialSubs[at(trialEnd)]--
            s.trialMrr[at(trialEnd)] -= p.monthlyCents
          }
        }
      }

      if (from === null) return // free, or a trial that never turned into money

      // Revenue starts: a plan change from a paying plan is expansion or contraction; anything
      // else (a new subscription, a converted trial, a resume, a move off a free plan) is new.
      const prev = list[i - 1]
      const handedOverFromPrev = p.kind === "change" && from === start && !!prev && prev.endReason === "replaced" && paidFrom(prev) !== null
      if (handedOverFromPrev) {
        const previous = prev.monthlyCents
        if (p.monthlyCents > previous) f.expansion[at(from)] += p.monthlyCents - previous
        else if (p.monthlyCents < previous) f.contraction[at(from)] += previous - p.monthlyCents
      } else {
        f.newMrr[at(from)] += p.monthlyCents
        f.newSubs[at(from)]++
      }
      s.subs[at(from)]++
      s.mrr[at(from)] += p.monthlyCents

      // Revenue ends: lost, unless a plan change hands it straight to a paying successor.
      if (p.endedAt) {
        const end = p.endedAt.getTime()
        s.subs[at(end)]--
        s.mrr[at(end)] -= p.monthlyCents
        const next = list[i + 1]
        const handedOverToNext = p.endReason === "replaced" && !!next && next.kind === "change" && paidFrom(next) === next.startedAt.getTime()
        if (!handedOverToNext) {
          f.churned[at(end)] += p.monthlyCents
          f.canceledSubs[at(end)]++
          if (lostToInactiveStore(p)) {
            f.churnedInactive[at(end)] += p.monthlyCents
            f.canceledInactive[at(end)]++
          }
        }
      }
    })
  }

  for (const t of trials) {
    f.trialsStarted[at(t.startedAt.getTime())]++
    if (t.outcome === "converted" && t.resolvedAt) f.trialsConverted[at(t.resolvedAt.getTime())]++
    if (t.outcome === "canceled" && t.resolvedAt) f.trialsCanceled[at(t.resolvedAt.getTime())]++
  }

  // Earnings from the payout ledger up to the cutoff and from the earning events after it
  // (countsAsEarning). The ledger's fee is everything Shopify kept (gross minus what reached the
  // payout); an earning event's is the revenue share it reports, which is all an earning event takes off.
  for (const e of moneyEvents) {
    const day = at(e.occurredAt.getTime())
    if (e.type.startsWith("CHARGE_")) f.charged[day] += e.amountCents ?? 0
    else if (e.type === EVENT.CREDIT_APPLIED) f.credit[day] += e.amountCents ?? 0
    if (e.type === EVENT.EARNING_REFUND) f.refunded[day] += Math.abs(e.grossCents ?? e.netCents ?? 0)
    if (!countsAsEarning(e, ledgerUntil)) continue
    if (LEDGER_TYPES.has(e.type)) {
      const { grossCents, netCents } = ledgerMoney(e)
      f.gross[day] += grossCents
      f.net[day] += netCents
      f.fee[day] += grossCents - netCents
    } else {
      f.gross[day] += e.grossCents ?? 0
      f.net[day] += e.netCents ?? 0
      f.fee[day] += e.feeCents ?? 0
    }
  }

  const rows: DailyRow[] = []
  const run = { installs: 0, subs: 0, mrr: 0, trialSubs: 0, trialMrr: 0 }
  for (let d = 0; d < length; d++) {
    run.installs += s.installs[d]
    run.subs += s.subs[d]
    run.mrr += s.mrr[d]
    run.trialSubs += s.trialSubs[d]
    run.trialMrr += s.trialMrr[d]
    rows.push({
      date: days[d],
      installs: f.installs[d],
      reinstalls: f.reinstalls[d],
      uninstalls: f.uninstalls[d],
      newSubs: f.newSubs[d],
      canceledSubs: f.canceledSubs[d],
      trialsStarted: f.trialsStarted[d],
      trialsConverted: f.trialsConverted[d],
      trialsCanceled: f.trialsCanceled[d],
      newMrrCents: f.newMrr[d],
      expansionMrrCents: f.expansion[d],
      contractionMrrCents: f.contraction[d],
      churnedMrrCents: f.churned[d],
      chargedCents: f.charged[d],
      grossEarnedCents: f.gross[d],
      netEarnedCents: f.net[d],
      feeCents: f.fee[d],
      refundedCents: f.refunded[d],
      creditCents: f.credit[d],
      deactivations: f.deactivations[d],
      reactivations: f.reactivations[d],
      uninstallsStoreInactive: f.uninstallsInactive[d],
      canceledSubsStoreInactive: f.canceledInactive[d],
      churnedMrrStoreInactiveCents: f.churnedInactive[d],
      activeInstalls: run.installs,
      activeSubs: run.subs,
      trialSubs: run.trialSubs,
      mrrCents: run.mrr,
      trialMrrCents: run.trialMrr,
    })
  }
  return rows
}
