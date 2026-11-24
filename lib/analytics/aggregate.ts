import { addDays, bucketKey, bucketsIn, nextBucket, toMs, type Granularity, type Range } from "./range"

// Everything the dashboard computes from the daily rollup, as pure functions of rows.
// Flows (installs, uninstalls, new MRR, charges) are what happened on a day and add up
// over a range. Stocks (active installs, subscriptions, MRR) are the value at the end of
// a day and are read at a date, never added over time.

export const FLOW_KEYS = [
  "installs", "reinstalls", "uninstalls",
  "newSubs", "canceledSubs",
  "trialsStarted", "trialsConverted", "trialsCanceled",
  "newMrrCents", "expansionMrrCents", "contractionMrrCents", "churnedMrrCents",
  "chargedCents", "grossEarnedCents", "netEarnedCents", "feeCents", "refundedCents", "creditCents",
  // Store deactivations, and the parts of the losses above that were the store going inactive.
  "deactivations", "reactivations", "uninstallsStoreInactive", "canceledSubsStoreInactive", "churnedMrrStoreInactiveCents",
] as const

/** activeSubs and mrrCents are paying only; trialSubs and trialMrrCents are the subscriptions still in a free trial. */
export const STOCK_KEYS = ["activeInstalls", "activeSubs", "trialSubs", "mrrCents", "trialMrrCents"] as const

export type FlowKey = (typeof FLOW_KEYS)[number]
export type StockKey = (typeof STOCK_KEYS)[number]
export type MetricKey = FlowKey | StockKey
export type Flows = Record<FlowKey, number>
export type Stocks = Record<StockKey, number>
export type DayRow = { appId: string; date: string } & Flows & Stocks

const zeroFlows = (): Flows => Object.fromEntries(FLOW_KEYS.map((k) => [k, 0])) as Flows
const zeroStocks = (): Stocks => Object.fromEntries(STOCK_KEYS.map((k) => [k, 0])) as Stocks

/** What happened between `from` and `to`, all apps together. */
export function sumFlows(rows: DayRow[], range: Range): Flows {
  const total = zeroFlows()
  for (const row of rows) {
    if (row.date < range.from || row.date > range.to) continue
    for (const key of FLOW_KEYS) total[key] += row[key]
  }
  return total
}

/** Rows grouped by app and sorted by date, ready for lookups. */
function byApp(rows: DayRow[]): Map<string, DayRow[]> {
  const map = new Map<string, DayRow[]>()
  for (const row of rows) {
    const list = map.get(row.appId)
    if (list) list.push(row)
    else map.set(row.appId, [row])
  }
  for (const list of map.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1))
  return map
}

/** The stock of one app at the end of `date`: its latest row on or before that day (zero before its first). */
function lastOnOrBefore(list: DayRow[], date: string): DayRow | null {
  let lo = 0
  let hi = list.length - 1
  let found: DayRow | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].date <= date) {
      found = list[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** The stocks at the end of `date`, all apps together. */
export function stocksAt(rows: DayRow[], date: string): Stocks {
  const total = zeroStocks()
  for (const list of byApp(rows).values()) {
    const row = lastOnOrBefore(list, date)
    if (row) for (const key of STOCK_KEYS) total[key] += row[key]
  }
  return total
}

const ratio = (numerator: number, denominator: number): number | null => (denominator > 0 ? numerator / denominator : null)

/**
 * What became of the shops that were there at the start of a range, by its end. Counting only
 * that starting group is what keeps these rates honest: a shop that joins and leaves inside
 * the range was never part of the base, so it cannot push a churn rate past 100%.
 * It cannot be rolled up from daily rows, so it is read from the per-shop tables.
 */
export type Retention = {
  /** Shops that had the app at the start, and how many still have it at the end. */
  startInstalls: number
  keptInstalls: number
  /** Paying subscribers at the start, and how many of them still pay at the end. */
  startSubs: number
  keptSubs: number
  /** Their MRR at the start; what the same shops pay at the end; and that, capped at what each paid at the start (no credit for upgrades). */
  startMrr: number
  endMrr: number
  keptMrr: number
}

export const noRetention = (): Retention => ({ startInstalls: 0, keptInstalls: 0, startSubs: 0, keptSubs: 0, startMrr: 0, endMrr: 0, keptMrr: 0 })

/** Retention for several apps together: the groups simply add. */
export function addRetention(list: Retention[]): Retention {
  const total = noRetention()
  for (const r of list) for (const key of Object.keys(total) as (keyof Retention)[]) total[key] += r[key]
  return total
}

export type Kpis = {
  installs: number; uninstalls: number; reinstalls: number; netInstalls: number
  activeInstalls: number; activeInstallsStart: number
  /** Of the shops that had the app at the start, the share that no longer has it at the end. */
  uninstallRate: number | null
  newSubs: number; canceledSubs: number; activeSubs: number; trialSubs: number
  mrr: number; trialMrr: number; mrrStart: number; mrrChange: number; mrrChangePct: number | null; arr: number
  newMrr: number; expansionMrr: number; contractionMrr: number; churnedMrr: number; netNewMrr: number
  /** Losses by cause: the store went inactive (closed, paused or unpaid), or the merchant left. Each pair adds up to its total. */
  uninstallsStoreInactive: number; uninstallsMerchantLeft: number
  canceledSubsStoreInactive: number; canceledSubsMerchantLeft: number
  churnedMrrStoreInactive: number; churnedMrrMerchantLeft: number
  deactivations: number; reactivations: number
  /** Net revenue retention: what the starting subscribers pay at the end, over what they paid at the start. */
  nrr: number | null
  /** Gross revenue retention: the same, with no credit for upgrades. */
  grr: number | null
  /** Of the paying subscribers at the start, the share no longer paying at the end. */
  subChurnRate: number | null
  /** The share of the starting MRR lost by the end: one minus gross revenue retention. */
  revenueChurnRate: number | null
  arpu: number | null
  /** Average revenue per subscriber over their expected life: a rough estimate, not a promise. */
  ltv: number | null
  trialsStarted: number; trialsConverted: number; trialsCanceled: number
  /** Converted over converted plus canceled: of the trials that ended one way or the other. */
  trialConversion: number | null
  charged: number; grossEarned: number; netEarned: number; fees: number; refunded: number; credits: number
  feeRate: number | null
}

/**
 * The headline numbers for a range. `retention` is what became of the starting shops
 * (see Retention); without it the five rates that depend on it are left empty rather than
 * guessed from flows.
 */
export function kpis(flows: Flows, start: Stocks, end: Stocks, days: number, retention: Retention | null = null): Kpis {
  const netNewMrr = flows.newMrrCents + flows.expansionMrrCents - flows.contractionMrrCents - flows.churnedMrrCents
  const r = retention
  const subChurnRate = r ? ratio(r.startSubs - r.keptSubs, r.startSubs) : null
  // Churn over the range, restated as churn per 30 days on the same steady rate, so a quarter and a week are comparable.
  const monthlyChurn = subChurnRate === null ? null : 1 - (1 - subChurnRate) ** (30 / Math.max(1, days))
  const arpu = ratio(end.mrrCents, end.activeSubs)

  return {
    installs: flows.installs,
    uninstalls: flows.uninstalls,
    reinstalls: flows.reinstalls,
    netInstalls: flows.installs - flows.uninstalls,
    activeInstalls: end.activeInstalls,
    activeInstallsStart: start.activeInstalls,
    uninstallRate: r ? ratio(r.startInstalls - r.keptInstalls, r.startInstalls) : null,
    newSubs: flows.newSubs,
    canceledSubs: flows.canceledSubs,
    activeSubs: end.activeSubs,
    trialSubs: end.trialSubs,
    mrr: end.mrrCents,
    trialMrr: end.trialMrrCents,
    mrrStart: start.mrrCents,
    mrrChange: end.mrrCents - start.mrrCents,
    mrrChangePct: ratio(end.mrrCents - start.mrrCents, start.mrrCents),
    arr: end.mrrCents * 12,
    newMrr: flows.newMrrCents,
    expansionMrr: flows.expansionMrrCents,
    contractionMrr: flows.contractionMrrCents,
    churnedMrr: flows.churnedMrrCents,
    netNewMrr,
    uninstallsStoreInactive: flows.uninstallsStoreInactive,
    uninstallsMerchantLeft: flows.uninstalls - flows.uninstallsStoreInactive,
    canceledSubsStoreInactive: flows.canceledSubsStoreInactive,
    canceledSubsMerchantLeft: flows.canceledSubs - flows.canceledSubsStoreInactive,
    churnedMrrStoreInactive: flows.churnedMrrStoreInactiveCents,
    churnedMrrMerchantLeft: flows.churnedMrrCents - flows.churnedMrrStoreInactiveCents,
    deactivations: flows.deactivations,
    reactivations: flows.reactivations,
    nrr: r ? ratio(r.endMrr, r.startMrr) : null,
    grr: r ? ratio(r.keptMrr, r.startMrr) : null,
    subChurnRate,
    revenueChurnRate: r ? ratio(r.startMrr - r.keptMrr, r.startMrr) : null,
    arpu,
    ltv: arpu !== null && monthlyChurn !== null && monthlyChurn > 0 ? arpu / monthlyChurn : null,
    trialsStarted: flows.trialsStarted,
    trialsConverted: flows.trialsConverted,
    trialsCanceled: flows.trialsCanceled,
    trialConversion: ratio(flows.trialsConverted, flows.trialsConverted + flows.trialsCanceled),
    charged: flows.chargedCents,
    grossEarned: flows.grossEarnedCents,
    netEarned: flows.netEarnedCents,
    fees: flows.feeCents,
    refunded: flows.refundedCents,
    credits: flows.creditCents,
    feeRate: ratio(flows.feeCents, flows.grossEarnedCents),
  }
}

/** The KPIs of a range, from rows that cover it and the day before it. */
export function kpisFor(rows: DayRow[], range: Range, retention: Retention | null = null): Kpis {
  const days = Math.round((toMs(range.to) - toMs(range.from)) / 86_400_000) + 1
  return kpis(sumFlows(rows, range), stocksAt(rows, addDays(range.from, -1)), stocksAt(rows, range.to), days, retention)
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export type SeriesPoint = { bucket: string } & Flows & Stocks

/**
 * One point per bucket (day, week or month) across the range, all apps together. Flows
 * are summed over the part of the bucket inside the range; stocks are read at the end of
 * it. Buckets with nothing in them are present, as zeros, so axes have no gaps.
 */
export function bucketSeries(rows: DayRow[], range: Range, granularity: Granularity): SeriesPoint[] {
  const buckets = bucketsIn(range, granularity)
  const index = new Map(buckets.map((b, i) => [b, i]))
  const points: SeriesPoint[] = buckets.map((bucket) => ({ bucket, ...zeroFlows(), ...zeroStocks() }))

  for (const row of rows) {
    if (row.date < range.from || row.date > range.to) continue
    const point = points[index.get(bucketKey(row.date, granularity))!]
    for (const key of FLOW_KEYS) point[key] += row[key]
  }

  const apps = byApp(rows)
  buckets.forEach((bucket, i) => {
    const endOfBucket = nextBucket(bucket, granularity)
    const readAt = addDays(endOfBucket, -1) > range.to ? range.to : addDays(endOfBucket, -1)
    for (const list of apps.values()) {
      const row = lastOnOrBefore(list, readAt)
      if (row) for (const key of STOCK_KEYS) points[i][key] += row[key]
    }
  })
  return points
}

/** One metric per app per bucket, for stacked charts and the app-by-app matrix. */
export function seriesByApp(rows: DayRow[], range: Range, granularity: Granularity, key: MetricKey): { bucket: string; values: Record<string, number> }[] {
  const buckets = bucketsIn(range, granularity)
  const index = new Map(buckets.map((b, i) => [b, i]))
  const out = buckets.map((bucket) => ({ bucket, values: {} as Record<string, number> }))
  const isStock = (STOCK_KEYS as readonly string[]).includes(key)

  const apps = byApp(rows)
  for (const [appId, list] of apps) {
    buckets.forEach((bucket, i) => {
      if (isStock) {
        const endOfBucket = addDays(nextBucket(bucket, granularity), -1)
        const row = lastOnOrBefore(list, endOfBucket > range.to ? range.to : endOfBucket)
        out[i].values[appId] = row ? row[key] : 0
      } else out[i].values[appId] ??= 0
    })
    if (!isStock) {
      for (const row of list) {
        if (row.date < range.from || row.date > range.to) continue
        out[index.get(bucketKey(row.date, granularity))!].values[appId] += row[key]
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

export type CohortRow = { cohort: string; size: number; cells: (number | null)[] }

/**
 * Of the shops that installed in each week (or month), what share was still installed
 * at the end of week 0, week 1, week 2 and on. A cell is empty until that period has
 * fully passed for the cohort, so a recent cohort has a short row.
 */
export function cohortRetention(
  stays: { installedAt: Date; uninstalledAt: Date | null }[],
  granularity: "week" | "month",
  now: Date,
  periods = 12,
): CohortRow[] {
  const today = now.toISOString().slice(0, 10)
  const cohorts = new Map<string, { installedAt: Date; uninstalledAt: Date | null }[]>()
  for (const stay of stays) {
    const key = bucketKey(stay.installedAt.toISOString().slice(0, 10), granularity)
    const list = cohorts.get(key)
    if (list) list.push(stay)
    else cohorts.set(key, [stay])
  }

  return [...cohorts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([cohort, members]) => {
      const cells: (number | null)[] = []
      let periodStart = cohort
      for (let k = 0; k < periods; k++) {
        const periodEnd = nextBucket(periodStart, granularity) // the first day after the period
        if (periodEnd > addDays(today, 1)) {
          cells.push(null)
        } else {
          const endMs = toMs(periodEnd)
          const kept = members.filter((m) => m.uninstalledAt === null || m.uninstalledAt.getTime() >= endMs).length
          cells.push(kept / members.length)
        }
        periodStart = periodEnd
      }
      return { cohort, size: members.length, cells }
    })
}
