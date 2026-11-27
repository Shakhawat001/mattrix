import { formatDateTime, formatDays, formatInt, formatMoney } from "@/lib/format"
import { formatDate } from "./range"
import { monthlyCents } from "./derive"
import { eventLabel, reasonLabel } from "./labels"
import type { ShopTimeline, TimelineEvent, TimelineSubscription } from "./shop-timeline"

// What the shop timeline page shows, worked out from getShopTimeline() without a database: the
// shop from the URL, where the shop stands now, and the story in plain words. The story has one
// row per event, plus the start and end of each free trial, which derive() works out (Shopify
// sends no event when a trial ends).

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** Letters, digits and hyphens, in two or more labels: demo-shop.myshopify.com. */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+$/

/**
 * The shop domain in a URL segment, decoded, trimmed and lowercased. Null when it does not look
 * like a domain (letters, digits, hyphens and dots, at most 255 characters).
 */
export function parseShopParam(raw: string): string | null {
  if (raw.length > 1000) return null
  let text: string
  try {
    text = decodeURIComponent(raw)
  } catch {
    return null
  }
  const domain = text.trim().toLowerCase()
  return domain.length <= 255 && SHOP_DOMAIN.test(domain) ? domain : null
}

type PricedPlan = { planHandle: string | null; billingPeriod: string | null; monthlyCents: number }

export type ShopStanding = {
  /** Whether the shop has the app installed now. Null when the data has no install or uninstall of it. */
  installed: boolean | null
  /** When the current stay began, or when the shop last uninstalled. */
  since: Date | null
  /** Its stays in the data: the first install and every return. */
  installs: number
  firstInstalledAt: Date | null
  /** What it is on now: a paid plan, a free trial of one, nothing it pays for, or nothing at all (not installed). */
  plan: ({ status: "paying" } & PricedPlan) | ({ status: "trial"; trialEndsAt: Date } & PricedPlan) | { status: "free"; planHandle: string | null } | { status: "none" }
  /** What it adds to MRR now: its plan's monthly price while it pays, otherwise 0. */
  mrrCents: number
}

/** Where the shop stands now, by the same rules as the shops page. */
export function shopStanding(t: Pick<ShopTimeline, "stays" | "subscriptions" | "events">): ShopStanding {
  const last = t.stays.at(-1)
  let installed: boolean | null = null
  let since: Date | null = null
  if (last) {
    installed = last.uninstalledAt === null
    since = last.uninstalledAt ?? last.installedAt
  } else {
    // No stay: the install came before the history starts, or the stays are not built yet.
    const latest = t.events.findLast((e) => e.type === "RELATIONSHIP_INSTALLED" || e.type === "RELATIONSHIP_UNINSTALLED")
    if (latest) {
      installed = latest.type === "RELATIONSHIP_INSTALLED"
      since = latest.occurredAt
    }
  }

  const open = t.subscriptions.findLast((s) => s.endedAt === null)
  let plan: ShopStanding["plan"]
  if (open && open.monthlyCents > 0) {
    const priced = { planHandle: open.planHandle, billingPeriod: open.billingPeriod, monthlyCents: open.monthlyCents }
    plan = open.trialEndsAt && !open.convertedAt ? { status: "trial", trialEndsAt: open.trialEndsAt, ...priced } : { status: "paying", ...priced }
  } else if (open || installed) {
    plan = { status: "free", planHandle: open?.planHandle ?? null }
  } else {
    plan = { status: "none" }
  }

  return {
    installed,
    since,
    installs: t.stays.length,
    firstInstalledAt: t.stays[0]?.installedAt ?? null,
    plan,
    mrrCents: plan.status === "paying" ? plan.monthlyCents : 0,
  }
}

export type TimelineRow = {
  /** Unique in the list: the event's id, or the trial and what happened to it. */
  key: string
  at: Date
  /** What happened, in a few words. An event type this page does not know is shown by its name. */
  title: string
  /** The particulars in plain words: the plan and price, the amount, the reason. */
  detail: string | null
  /** The merchant's own words, exactly as Shopify sent them. Untrusted: show them as text. */
  quote: string | null
  /** The Shopify event type of the row. Null for the start or end of a trial, which derive() works out. */
  type: string | null
  /** A loss (an uninstall, a cancel, a refund), money coming in, or anything else. */
  tone: "loss" | "money" | "plain"
}

const count = (n: number, one: string) => `${formatInt(n)} ${n === 1 ? one : `${one}s`}`

/** Parts of a detail, the empty ones left out. */
const sentence = (...parts: (string | null)[]): string | null => parts.filter(Boolean).join(". ") || null

/** "pro at $24.99 a month", "pro at $20 a month, billed $240 a year", "basic, free". A null price is a plan with no flat price. */
function planWords(p: { planHandle: string | null; billingPeriod: string | null; monthlyCents: number | null }, yearlyCents: number | null = null): string {
  const name = p.planHandle ?? "an unnamed plan"
  if (p.monthlyCents === null) return `${name}, with no flat price`
  if (p.monthlyCents === 0) return `${name}, free`
  const monthly = `${name} at ${formatMoney(p.monthlyCents)} a month`
  if (p.billingPeriod !== "ANNUAL") return monthly
  return `${monthly}, billed ${yearlyCents === null ? "yearly" : `${formatMoney(yearlyCents)} a year`}`
}

/** The plan an event names, with its price when the event has one. */
function namedPlan(e: TimelineEvent): string | null {
  if (e.amountCents === null) return e.planHandle
  return planWords({ planHandle: e.planHandle, billingPeriod: e.billingPeriod, monthlyCents: monthlyCents(e.amountCents, e.billingPeriod) }, e.billingPeriod === "ANNUAL" ? e.amountCents : null)
}

/** A subscription period as the event that opened it describes it. */
function periodWords(p: TimelineSubscription, e: TimelineEvent): string {
  // Priced at nothing because Shopify sent no price: a usage-only plan, or a price missing from the data.
  const monthly = p.monthlyCents === 0 && e.amountCents === null ? null : p.monthlyCents
  const yearly = p.billingPeriod === "ANNUAL" && e.amountCents !== null && monthlyCents(e.amountCents, "ANNUAL") === p.monthlyCents ? e.amountCents : null
  return planWords({ planHandle: p.planHandle, billingPeriod: p.billingPeriod, monthlyCents: monthly }, yearly)
}

/** Shopify's comma-separated uninstall reasons as words, "Too expensive, App not working", or null when there is none. */
export function reasonsLabel(reason: string | null): string | null {
  const list = (reason ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map(reasonLabel)
  return list.length ? list.join(", ") : null
}

function lasted(ms: number): string {
  if (ms < HOUR_MS) return "less than an hour"
  if (ms < DAY_MS) return count(Math.round(ms / HOUR_MS), "hour")
  return formatDays(ms / DAY_MS)
}

/** "$20 gross, $17 net, Shopify's fee $3", each with the sign Shopify gave it. */
function earningWords(e: TimelineEvent): string | null {
  const parts = [
    e.grossCents === null ? null : `${formatMoney(e.grossCents)} gross`,
    e.netCents === null ? null : `${formatMoney(e.netCents)} net`,
    e.feeCents === null ? null : `Shopify's fee ${formatMoney(e.feeCents)}`,
  ].filter(Boolean)
  return parts.length ? parts.join(", ") : null
}

/**
 * The day a cancel takes effect, as Shopify names it. cancelEffectiveOn is a date with no time,
 * stored as midnight UTC of it, so it is written as that date: it takes effect as the day begins.
 */
const effectiveDay = (date: Date) => `Takes effect ${formatDate(date.toISOString().slice(0, 10))}`

/** A cancel's end, when Shopify says it comes later than the cancel. */
const laterEnd = (e: TimelineEvent): string | null =>
  e.cancelEffectiveOn && e.cancelEffectiveOn.getTime() > e.occurredAt.getTime() ? effectiveDay(e.cancelEffectiveOn) : null

/**
 * The shop's story as rows, oldest first: one per event, in the order the read returns them, and
 * the start and end of each free trial. On the same instant a trial's conversion comes before the
 * events (a charge at the end of a trial follows it), and a trial's start and cancel come after
 * them (after the subscription that began it, or the cancel or uninstall that ended it). When the
 * event list was cut to the latest events, trial rows older than the first event shown are left
 * out too. An event type not known here is kept, shown by its name with what it carries.
 */
/** `timeZone` is the dashboard's, which the times in the rows are written in. */
export function timelineRows(t: Pick<ShopTimeline, "stays" | "subscriptions" | "trials" | "events" | "eventCount">, timeZone: string): TimelineRow[] {
  const staysByStart = new Map(t.stays.map((s) => [s.installedAt.getTime(), s]))
  const staysByEnd = new Map(t.stays.flatMap((s) => (s.uninstalledAt ? [[s.uninstalledAt.getTime(), s] as const] : [])))

  // The subscription periods by start, so each event that began one can say what it was: a new
  // subscription, a plan change from the period before it, or a resume. Each is claimed once.
  const startingAt = new Map<number, number[]>()
  t.subscriptions.forEach((p, i) => {
    const at = p.startedAt.getTime()
    startingAt.set(at, [...(startingAt.get(at) ?? []), i])
  })
  const claim = (at: number): number | null => startingAt.get(at)?.shift() ?? null
  // How each claimed period was described, so a plan change names the plan it left the same way.
  const described = new Map<number, string>()
  const describe = (i: number, words: string) => {
    described.set(i, words)
    return words
  }
  // Uninstalled and not installed again since, as derive() tracks it: a subscription created or
  // updated meanwhile is not counted, since an uninstall cancels the app's subscriptions.
  let uninstalled = false

  function rowOf(e: TimelineEvent): TimelineRow {
    const at = e.occurredAt.getTime()
    const base = { key: e.id, at: e.occurredAt, quote: e.reasonDescription, type: e.type }
    switch (e.type) {
      case "RELATIONSHIP_INSTALLED": {
        uninstalled = false
        const stay = staysByStart.get(at)
        return stay && stay.seq > 1
          ? { ...base, title: "Reinstalled", detail: `Install ${formatInt(stay.seq)} of this shop`, tone: "plain" }
          : { ...base, title: "Installed", detail: null, tone: "plain" }
      }
      case "RELATIONSHIP_UNINSTALLED": {
        uninstalled = true
        const stay = staysByEnd.get(at)
        const why = reasonsLabel(e.reason)
        return { ...base, title: "Uninstalled", detail: sentence(why ? `Reason: ${why}` : "No reason given", stay ? `Installed for ${lasted(at - stay.installedAt.getTime())}` : null), tone: "loss" }
      }
      case "RELATIONSHIP_DEACTIVATED": {
        const why = reasonsLabel(e.reason)
        return { ...base, title: "Store deactivated", detail: sentence("Shopify deactivated the shop's billing account", why ? `Reason: ${why}` : null), tone: "loss" }
      }
      case "RELATIONSHIP_REACTIVATED":
        return { ...base, title: "Store reactivated", detail: "Shopify reactivated the shop's billing account", tone: "plain" }
      case "SUBSCRIPTION_CREATED":
      case "SUBSCRIPTION_UPDATED": {
        const i = claim(at)
        if (i !== null) {
          const p = t.subscriptions[i]
          if (p.kind === "change") {
            const before = t.subscriptions[i - 1]
            const from = described.get(i - 1) ?? planWords({ planHandle: before?.planHandle ?? null, billingPeriod: before?.billingPeriod ?? null, monthlyCents: p.previousMonthlyCents ?? before?.monthlyCents ?? null })
            return { ...base, title: "Plan changed", detail: `From ${from} to ${describe(i, periodWords(p, e))}`, tone: "plain" }
          }
          return { ...base, title: "Subscribed", detail: sentence(describe(i, periodWords(p, e)), e.type === "SUBSCRIPTION_UPDATED" ? "First seen in an update" : null), tone: "plain" }
        }
        // Nothing began here: it came after an uninstall, it changed no plan or price, or the periods are not built yet.
        return {
          ...base,
          title: e.type === "SUBSCRIPTION_CREATED" ? "Subscribed" : "Subscription updated",
          detail: sentence(namedPlan(e), uninstalled ? "Not counted: it came after the uninstall" : null),
          tone: "plain",
        }
      }
      case "SUBSCRIPTION_CANCELED":
        return { ...base, title: "Canceled", detail: sentence(namedPlan(e), laterEnd(e)), tone: "loss" }
      case "SUBSCRIPTION_CANCELLATION_SCHEDULED":
        return {
          ...base,
          title: "Cancellation scheduled",
          detail: sentence(namedPlan(e), e.cancelEffectiveOn ? effectiveDay(e.cancelEffectiveOn) : "Shopify gave no date"),
          tone: "loss",
        }
      case "SUBSCRIPTION_FROZEN":
        return { ...base, title: "Frozen", detail: sentence(namedPlan(e), "On hold for non-payment until payments resume"), tone: "loss" }
      case "SUBSCRIPTION_UNFROZEN": {
        const i = claim(at)
        let plan = namedPlan(e)
        if (i !== null) {
          // A resume carries on the plan that was frozen, told the same way when nothing about it changed.
          const p = t.subscriptions[i]
          const before = t.subscriptions[i - 1]
          const same = before && before.planHandle === p.planHandle && before.billingPeriod === p.billingPeriod && before.monthlyCents === p.monthlyCents
          plan = describe(i, (same ? described.get(i - 1) : undefined) ?? planWords(p))
        }
        return { ...base, title: "Unfrozen", detail: plan ? `Billing resumed: ${plan}` : "Billing resumed", tone: "plain" }
      }
      case "CHARGE_RECURRING":
      case "CHARGE_ONE_TIME":
      case "CHARGE_USAGE": {
        const amount = e.amountCents === null ? "No amount reported" : formatMoney(e.amountCents)
        return { ...base, title: eventLabel(e.type), detail: e.planHandle ? `${amount} for ${e.planHandle}` : amount, tone: "money" }
      }
      case "EARNING_REFUND":
        return { ...base, title: "Refund", detail: earningWords(e), tone: "loss" }
      case "EARNING_CHARGE_RECURRING":
      case "EARNING_CHARGE_ONE_TIME":
      case "EARNING_CHARGE_USAGE":
      case "EARNING_ADJUSTMENT":
      case "EARNING_CREDIT":
        return { ...base, title: eventLabel(e.type), detail: earningWords(e), tone: "money" }
      case "CREDIT_PENDING":
      case "CREDIT_APPLIED":
      case "CREDIT_FAILED":
        return { ...base, title: eventLabel(e.type), detail: e.amountCents === null ? null : `${formatMoney(e.amountCents)} of app credit`, tone: "money" }
      default: {
        const why = reasonsLabel(e.reason)
        return {
          ...base,
          title: eventLabel(e.type),
          detail: sentence(
            e.planHandle ? `Plan ${e.planHandle}` : null,
            e.amountCents === null ? null : formatMoney(e.amountCents),
            earningWords(e),
            why ? `Reason: ${why}` : null,
            e.state ? `State ${e.state}` : null,
          ),
          tone: "plain",
        }
      }
    }
  }

  // Sorted by time, then phase: 0 a trial's conversion, 1 the events, 2 a trial's start, 3 its cancel.
  const sorted: { row: TimelineRow; at: number; phase: number; order: number }[] = t.events.map((e, i) => ({ row: rowOf(e), at: e.occurredAt.getTime(), phase: 1, order: i }))

  t.trials.forEach((trial, i) => {
    const base = { quote: null, type: null }
    sorted.push({
      row: { ...base, key: `trial-${i}-start`, at: trial.startedAt, title: "Trial started", detail: `${count(trial.trialDays, "day")}, set to end ${formatDateTime(trial.endsAt, timeZone)}`, tone: "plain" },
      at: trial.startedAt.getTime(),
      phase: 2,
      order: i,
    })
    if (!trial.resolvedAt || trial.outcome === "open") return
    const ended = trial.resolvedAt.getTime()
    if (trial.outcome === "converted") {
      // The period in force when the trial turned into money (a plan changed during a trial carries it on).
      const k = t.subscriptions.findLastIndex((p) => p.convertedAt?.getTime() === ended && p.startedAt.getTime() <= ended && p.monthlyCents > 0)
      const paying = k < 0 ? null : (described.get(k) ?? planWords(t.subscriptions[k]))
      sorted.push({
        row: { ...base, key: `trial-${i}-end`, at: trial.resolvedAt, title: "Trial converted", detail: paying ? `Started paying for ${paying}` : null, tone: "plain" },
        at: ended,
        phase: 0,
        order: i,
      })
    } else {
      sorted.push({
        row: { ...base, key: `trial-${i}-end`, at: trial.resolvedAt, title: "Trial canceled", detail: "The subscription ended during the trial", tone: "loss" },
        at: ended,
        phase: 3,
        order: i,
      })
    }
  })

  const from = t.eventCount > t.events.length && t.events.length > 0 ? t.events[0].occurredAt.getTime() : -Infinity
  return sorted
    .filter((s) => s.phase === 1 || s.at >= from)
    .sort((a, b) => a.at - b.at || a.phase - b.phase || a.order - b.order)
    .map((s) => s.row)
}
