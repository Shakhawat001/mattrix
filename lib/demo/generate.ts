import type { ParsedEvent } from "@/lib/partner/parse"

// A year of plausible history for a few invented apps, so the dashboard can be tried,
// screenshotted and tested without a Shopify account. Deterministic for a given seed.
// It produces the same shape of event the Partner API does, and goes through the same
// storage and the same derivation as real data.

const DAY_MS = 86_400_000

export type DemoApp = {
  name: string
  planHandle: string
  monthlyCents: number
  /** Yearly price, if the app sells one. */
  yearlyCents: number | null
  trialDays: number
  /** Installs per day on day `d` of `days`. */
  installsPerDay: (d: number, days: number) => number
  /** Share of installs that ever start a subscription. */
  paidShare: number
  /** Share of trials that turn into a first charge. */
  trialConvert: number
  /** Chance a paying shop cancels at each billing cycle. */
  churnPerCycle: number
  /** Mean days a shop keeps the app, past the first few days. */
  meanLifetimeDays: number
}

export const DEMO_APPS: DemoApp[] = [
  {
    name: "Badge Pro",
    planHandle: "pro",
    monthlyCents: 2499,
    yearlyCents: 24000,
    trialDays: 7,
    installsPerDay: (d, days) => 1.6 + (d / days) * 5,
    paidShare: 0.14,
    trialConvert: 0.52,
    churnPerCycle: 0.045,
    meanLifetimeDays: 160,
  },
  {
    name: "Image Squeezer",
    planHandle: "plus",
    monthlyCents: 999,
    yearlyCents: 9900,
    trialDays: 14,
    installsPerDay: () => 4.2,
    paidShare: 0.09,
    trialConvert: 0.44,
    churnPerCycle: 0.06,
    meanLifetimeDays: 230,
  },
  {
    name: "Cart Notes",
    planHandle: "notes",
    monthlyCents: 499,
    yearlyCents: null,
    trialDays: 0,
    installsPerDay: (d, days) => 0.6 + (d / days) * 0.9,
    paidShare: 0.07,
    trialConvert: 1,
    churnPerCycle: 0.1,
    meanLifetimeDays: 70,
  },
]

const REASONS = [
  ["too_expensive", 0.22],
  ["app_not_working", 0.18],
  ["found_alternative", 0.16],
  ["no_longer_needed", 0.18],
  ["store_closed", 0.1],
  ["missing_feature", 0.1],
  ["other", 0.06],
] as const

const WORDS: Record<string, string[]> = {
  too_expensive: ["Too much for a store our size.", "Good app, but the monthly price is hard to justify."],
  app_not_working: ["Nothing showed up on my product pages.", "Could not get it to work with my theme."],
  found_alternative: ["Switched to another app that does this for free."],
  missing_feature: ["Needed it on the collection page too.", "Wanted per-market pricing."],
  no_longer_needed: ["We stopped running promotions."],
}

/** mulberry32: a small seeded generator, so demo data is repeatable. */
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

export function generateDemoEvents(options: { now: Date; days?: number; seed?: number; apps?: DemoApp[] }): { events: ParsedEvent[]; apps: { gid: string; name: string }[] } {
  const { now, days = 330, seed = 20260101, apps = DEMO_APPS } = options
  const rand = random(seed)
  const poisson = (lambda: number) => {
    const limit = Math.exp(-lambda)
    let k = 0
    let p = 1
    do {
      k++
      p *= rand()
    } while (p > limit)
    return k - 1
  }
  const pick = <T,>(table: readonly (readonly [T, number])[]): T => {
    let r = rand()
    for (const [value, weight] of table) if ((r -= weight) <= 0) return value
    return table[table.length - 1][0]
  }
  const between = (min: number, max: number) => min + rand() * (max - min)

  const events: ParsedEvent[] = []
  const out: { gid: string; name: string }[] = []
  let eventCounter = 0
  let shopCounter = 0

  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())

  apps.forEach((app, appIndex) => {
    const appGid = `gid://shopify/App/${9000 + appIndex}`
    const appApiKey = `demo-api-key-${appIndex}`
    out.push({ gid: appGid, name: app.name })

    const emit = (type: string, at: number, shop: string, shopGid: string, over: Partial<ParsedEvent> = {}) => {
      if (at > now.getTime()) return
      events.push({
        id: `gid://shopify/Event/demo-${++eventCounter}`,
        occurredAt: new Date(at),
        type,
        appGid,
        appName: app.name,
        appApiKey,
        shop,
        shopGid,
        state: null,
        reason: null,
        reasonDescription: null,
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
        chargeId: null,
        payload: { demo: true },
        ...over,
      })
    }

    // One shop's stay, which can include a subscription and, later, a return.
    const stay = (shop: string, shopGid: string, installAt: number, allowReturn: boolean) => {
      emit("RELATIONSHIP_INSTALLED", installAt, shop, shopGid, { state: "INSTALLED" })

      // How long it stays.
      const quick = rand() < 0.26
      const lifetime = quick ? between(0.01, 3) * DAY_MS : (3 + -Math.log(1 - rand()) * app.meanLifetimeDays) * DAY_MS
      const uninstallAt = installAt + lifetime

      // Does it pay, and for how long.
      let subscriptionEnd = Infinity
      if (!quick && rand() < app.paidShare * 1.3) {
        const startsAt = installAt + between(0, 9) * DAY_MS
        const yearly = app.yearlyCents !== null && rand() < 0.2
        const price = yearly ? (app.yearlyCents as number) : app.monthlyCents
        const period = yearly ? "ANNUAL" : "EVERY_30_DAYS"
        const cycleMs = (yearly ? 365 : 30) * DAY_MS
        const plan = { planHandle: app.planHandle, billingPeriod: period, amountCents: price }

        if (startsAt < uninstallAt) {
          emit("SUBSCRIPTION_CREATED", startsAt, shop, shopGid, { ...plan, state: "CREATED", trialDays: app.trialDays || null })
          const trialEnd = startsAt + app.trialDays * DAY_MS

          if (app.trialDays > 0 && rand() > app.trialConvert) {
            subscriptionEnd = Math.min(uninstallAt, trialEnd - between(0.2, app.trialDays) * DAY_MS)
            emit("SUBSCRIPTION_CANCELED", subscriptionEnd, shop, shopGid, { state: "CANCELED" })
          } else {
            let chargeAt = app.trialDays > 0 ? trialEnd : startsAt
            let cycle = 0
            let planChanged = false
            while (chargeAt < uninstallAt && chargeAt <= now.getTime()) {
              const gross = planChanged ? Math.round(price * 1.4) : price
              emit("CHARGE_RECURRING", chargeAt, shop, shopGid, { amountCents: gross, planHandle: app.planHandle, chargeId: `demo-charge-${eventCounter}` })
              const fee = Math.round(gross * 0.029)
              emit("EARNING_CHARGE_RECURRING", chargeAt + 2 * DAY_MS, shop, shopGid, { grossCents: gross, netCents: gross - fee, feeCents: fee })
              if (rand() < 0.02) emit("EARNING_REFUND", chargeAt + 4 * DAY_MS, shop, shopGid, { grossCents: -gross, netCents: -(gross - fee), feeCents: -fee })
              cycle++
              if (!planChanged && cycle > 1 && rand() < 0.05) {
                planChanged = true
                emit("SUBSCRIPTION_UPDATED", chargeAt + between(2, 25) * DAY_MS, shop, shopGid, { ...plan, amountCents: Math.round(price * 1.4), state: "UPDATED" })
              }
              if (rand() < app.churnPerCycle * (yearly ? 3 : 1)) {
                subscriptionEnd = chargeAt + between(5, 28) * DAY_MS
                emit("SUBSCRIPTION_CANCELED", Math.min(subscriptionEnd, uninstallAt), shop, shopGid, { state: "CANCELED" })
                break
              }
              chargeAt += cycleMs
            }
          }
        }
      }

      // The uninstall, or a cancel that comes first and takes the shop with it.
      const leavesAt = Math.min(uninstallAt, subscriptionEnd < Infinity && rand() < 0.5 ? subscriptionEnd + between(0, 4) * DAY_MS : uninstallAt)
      if (leavesAt <= now.getTime()) {
        const reason = pick(REASONS)
        const words = rand() < 0.3 ? WORDS[reason]?.[Math.floor(rand() * WORDS[reason].length)] : undefined
        emit("RELATIONSHIP_UNINSTALLED", leavesAt, shop, shopGid, { state: "UNINSTALLED", reason, reasonDescription: words ?? null })
        if (allowReturn && rand() < 0.06) stay(shop, shopGid, leavesAt + between(2, 60) * DAY_MS, false)
      }
    }

    for (let d = 0; d < days; d++) {
      const dayStart = startOfToday - (days - 1 - d) * DAY_MS
      const weekday = new Date(dayStart).getUTCDay()
      const weekend = weekday === 0 || weekday === 6 ? 0.7 : 1.05
      const installs = poisson(app.installsPerDay(d, days) * weekend)
      for (let i = 0; i < installs; i++) {
        shopCounter++
        const shop = `demo-shop-${shopCounter}.myshopify.com`
        stay(shop, `gid://shopify/Shop/${shopCounter}`, dayStart + Math.floor(rand() * DAY_MS), true)
      }
    }
  })

  return { events, apps: out }
}
