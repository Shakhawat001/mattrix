import type { Kpis } from "./aggregate"

// Every number the dashboard shows is defined here once: its name, how it is written, and
// what it means in plain words. The KPI cards, the app-by-app matrix, the tooltips and
// docs/METRICS.md all read from this list, so a definition cannot drift between them.

export type MetricFormat = "int" | "money" | "percent" | "days"
export type MetricDef = {
  label: string
  /** A shorter heading for tight spaces such as table columns. The label is used when there is none. */
  short?: string
  format: MetricFormat
  /** Which direction is an improvement, for colouring a change. */
  good: "up" | "down" | "none"
  description: string
}

export const METRICS = {
  activeInstalls: { label: "Active installs", short: "Installs", format: "int", good: "up", description: "Shops that have the app installed at the end of the period." },
  installs: { label: "New installs", format: "int", good: "up", description: "Installs during the period. A shop that comes back counts again." },
  reinstalls: { label: "Reinstalls", format: "int", good: "up", description: "Installs by a shop that had installed the app before." },
  uninstalls: { label: "Uninstalls", format: "int", good: "down", description: "Uninstall events during the period." },
  uninstallsStoreInactive: { label: "Uninstalls (store inactive)", short: "Uninstalls (inactive)", format: "int", good: "down", description: "Uninstalls while Shopify had the store's billing account deactivated, because the store closed, paused or stopped paying Shopify." },
  uninstallsMerchantLeft: { label: "Uninstalls (merchant left)", short: "Uninstalls (left)", format: "int", good: "down", description: "Uninstalls from stores that were active: every uninstall not counted as store inactive." },
  netInstalls: { label: "Net installs", format: "int", good: "up", description: "Installs minus uninstalls." },
  uninstallRate: { label: "Uninstall rate", format: "percent", good: "down", description: "Of the shops that had the app at the start of the period, the share that no longer has it at the end. Shops that installed during the period are not counted, so it stays between 0% and 100%." },
  deactivations: { label: "Stores deactivated", short: "Deactivated", format: "int", good: "down", description: "Times during the period that Shopify deactivated the billing account of a store with the app: the store closed, paused or stopped paying Shopify. The app stays installed until it is uninstalled." },
  reactivations: { label: "Stores reactivated", short: "Reactivated", format: "int", good: "up", description: "Times during the period that Shopify reactivated a deactivated store's billing account: the store came back." },
  activeSubs: { label: "Subscribers", format: "int", good: "up", description: "Shops paying for a plan at the end of the period. A free trial is not counted until it converts." },
  trialSubs: { label: "In trial", format: "int", good: "up", description: "Shops on a free trial of a paid plan at the end of the period. They become subscribers when the trial ends with the subscription still open." },
  newSubs: { label: "New subscribers", format: "int", good: "up", description: "Shops that started paying during the period: a subscription with no trial, a trial that converted, a move off a free plan, or a resumed subscription." },
  canceledSubs: { label: "Canceled subscribers", format: "int", good: "down", description: "Paying subscriptions that ended during the period, by cancel, uninstall or freeze, or by a move to a free plan. A trial that ends without paying is counted under trials, not here." },
  canceledSubsStoreInactive: { label: "Canceled subscribers (store inactive)", short: "Canceled (inactive)", format: "int", good: "down", description: "Paying subscriptions that ended because the store went inactive: Shopify froze the charge, or it was canceled or uninstalled while Shopify had the store deactivated (closed, paused or unpaid)." },
  canceledSubsMerchantLeft: { label: "Canceled subscribers (merchant left)", short: "Canceled (left)", format: "int", good: "down", description: "Paying subscriptions that ended any other way: canceled or uninstalled while the store was active, or moved to a free plan. Canceled subscribers minus the store inactive ones." },
  mrr: { label: "MRR", format: "money", good: "up", description: "Monthly recurring revenue at the end of the period: the price of every paying subscription, with a yearly price divided by twelve. Free trials are left out until they convert." },
  trialMrr: { label: "MRR in trial", format: "money", good: "up", description: "What the free trials running at the end of the period would add to MRR if every one of them converted." },
  arr: { label: "ARR", format: "money", good: "up", description: "Annual run rate: the MRR at the end of the period times twelve." },
  mrrChange: { label: "MRR change", format: "money", good: "up", description: "MRR at the end of the period minus MRR at its start." },
  newMrr: { label: "New MRR", format: "money", good: "up", description: "MRR from shops that started paying during the period, including trials that converted." },
  expansionMrr: { label: "Expansion MRR", format: "money", good: "up", description: "MRR added by existing subscribers moving to a pricier plan." },
  contractionMrr: { label: "Contraction MRR", format: "money", good: "down", description: "MRR lost to existing subscribers moving to a cheaper paid plan." },
  churnedMrr: { label: "Churned MRR", format: "money", good: "down", description: "MRR lost when paying subscriptions ended by cancel, uninstall or freeze, or moved to a free plan. A cancel counts on the day it takes effect." },
  churnedMrrStoreInactive: { label: "Churned MRR (store inactive)", short: "Churn (inactive)", format: "money", good: "down", description: "Churned MRR from subscriptions that ended because the store went inactive: Shopify froze the charge, or it was canceled or uninstalled while Shopify had the store deactivated (closed, paused or unpaid)." },
  churnedMrrMerchantLeft: { label: "Churned MRR (merchant left)", short: "Churn (left)", format: "money", good: "down", description: "Churned MRR from every other end: a cancel or an uninstall while the store was active, or a move to a free plan. Churned MRR minus the store inactive part." },
  netNewMrr: { label: "Net new MRR", format: "money", good: "up", description: "New plus expansion, minus contraction and churned MRR. It equals the MRR change." },
  nrr: { label: "Net revenue retention", short: "NRR", format: "percent", good: "up", description: "What the subscribers you had at the start of the period pay at the end, over what they paid at the start. It counts upgrades, downgrades and cancels, and leaves out anyone who joined later. Above 100% means upgrades outweighed losses." },
  grr: { label: "Gross revenue retention", short: "GRR", format: "percent", good: "up", description: "The same without credit for upgrades: how much of the starting MRR you kept, at most what each subscriber paid at the start. It cannot exceed 100%." },
  subChurnRate: { label: "Subscriber churn", short: "Sub. churn", format: "percent", good: "down", description: "Of the paying subscribers you had at the start of the period, the share that no longer pays at the end. Subscribers who joined during the period are not counted, so it stays between 0% and 100%." },
  revenueChurnRate: { label: "Revenue churn", short: "Rev. churn", format: "percent", good: "down", description: "The share of the starting MRR that was gone by the end, counting cancels and downgrades of the subscribers you had at the start. It is 100% minus gross revenue retention." },
  arpu: { label: "ARPU", format: "money", good: "up", description: "Average revenue per paying subscriber per month: MRR divided by subscribers." },
  ltv: { label: "Lifetime value (estimate)", format: "money", good: "up", description: "ARPU divided by subscriber churn per month, with churn over the range restated per 30 days. A rough estimate that moves a lot with small samples; treat it as a direction, not a promise." },
  trialsStarted: { label: "Trials started", format: "int", good: "up", description: "Free trials that began during the period." },
  trialsConverted: { label: "Trials converted", format: "int", good: "up", description: "Trials that turned into a paying subscription during the period: the trial ended with the subscription still open, or an earlier charge came in." },
  trialsCanceled: { label: "Trials canceled", format: "int", good: "down", description: "Trials that ended in a cancel, an uninstall or a freeze before the subscription started paying." },
  trialConversion: { label: "Trial to paid", format: "percent", good: "up", description: "Trials converted divided by trials converted plus canceled, in the period. Trials still running are left out." },
  charged: { label: "Charged", format: "money", good: "up", description: "What merchants were charged, before Shopify's fees, by the date of the charge." },
  grossEarned: { label: "Gross earnings", format: "money", good: "up", description: "Earnings before Shopify's fee, as Shopify reports them (refunds and adjustments are included, with their sign)." },
  netEarned: { label: "Net earnings", format: "money", good: "up", description: "What reaches you after Shopify's fee. Needs a token that can read earnings." },
  fees: { label: "Shopify fees", format: "money", good: "down", description: "The revenue share Shopify kept from your charges, as its earnings events report it." },
  feeRate: { label: "Fee rate", format: "percent", good: "down", description: "Shopify's fees divided by gross earnings." },
  refunded: { label: "Refunded", format: "money", good: "down", description: "Value of charges refunded to merchants during the period." },
  credits: { label: "Credits applied", format: "money", good: "down", description: "Value of app credits applied for merchants during the period." },
} as const satisfies Record<string, MetricDef>

export type MetricId = keyof typeof METRICS

// A metric that is not a field of the KPIs would show as blank. This stops compiling if one slips in.
type EveryMetricIsAKpi = MetricId extends keyof Kpis ? true : never
export const _everyMetricIsAKpi: EveryMetricIsAKpi = true

export const metricValue = (kpis: Kpis, id: MetricId): number | null => kpis[id]

/** The heading to use where space is tight. */
export const shortLabel = (id: MetricId): string => (METRICS[id] as MetricDef).short ?? METRICS[id].label

/**
 * Numbers that follow a group of shops from the range up to today, each read from the per-shop
 * tables for one block of a page: the revenue cohorts and win-back. They are not KPIs of a range
 * (no card, no comparison, nothing that adds up), so they are kept out of METRICS, but they are
 * defined here the same way and written into docs/METRICS.md with the rest.
 */
export const COHORT_METRICS = {
  cohortMrrRetention: { label: "Revenue retention by cohort", format: "percent", good: "up", description: "Shops grouped by the month they first started paying, a trial counting from its conversion. At the end of that month and of each month after, the MRR those shops still pay over what they paid when they started. Upgrades count, so it can pass 100%." },
  wonBack: { label: "Shops won back", format: "int", good: "up", description: "Shops that uninstalled during the period and installed the app again afterwards, up to today. A shop counts once however often it left." },
  winBackRate: { label: "Win-back rate", format: "percent", good: "up", description: "Of the shops that uninstalled during the period, the share that installed the app again afterwards, up to today. It stays between 0% and 100%." },
  daysToReturn: { label: "Time to return", format: "days", good: "none", description: "The median time from a shop's first uninstall during the period to its next install, among the shops won back." },
} as const satisfies Record<string, MetricDef>

export type CohortMetricId = keyof typeof COHORT_METRICS
