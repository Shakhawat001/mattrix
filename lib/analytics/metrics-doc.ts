import { AT_RISK_METRICS, COHORT_METRICS, METRICS, type MetricDef, type MetricFormat } from "./metrics-registry"

// docs/METRICS.md is written from the registry that the dashboard's own tooltips read, so what
// the page says and what the file says cannot disagree. `pnpm docs:metrics` rewrites the file;
// a test fails when the committed copy is out of date. The MCP endpoint serves the same text.

export const UNIT: Record<MetricFormat, string> = { int: "count", money: "US dollars", percent: "percent", days: "days" }
export const BETTER: Record<MetricDef["good"], string> = { up: "higher", down: "lower", none: "neither" }

/** The rules every number follows, in markdown. */
export const CONVENTIONS: readonly string[] = [
  "**Days are in your time zone.** You pick the zone in Settings (it is UTC until you do). A day runs from midnight to midnight there, so on a daylight saving change it is 23 or 25 hours long, and every time in the dashboard is shown on that zone's clock. A range includes both of its end days. CSV exports give dates in the same zone and moments in UTC (ISO 8601).",
  "**Money is stored in cents and shown in US dollars.** Shopify charges for apps are in US dollars.",
  "**Monthly value.** A yearly price counts as a twelfth of itself each month. Every MRR figure uses it.",
  "**A subscriber is a shop paying for a plan.** A plan priced at $0 is not one, and neither is a free trial until it converts, so MRR leaves trials out (the usual SaaS definition, used by ChartMogul, Baremetrics and Stripe). Trials are counted on their own: In trial, MRR in trial and trial conversion.",
  "**A trial converts when it ends with the subscription still open**, or earlier if a real charge comes in first. Shopify bills app charges on the merchant's own invoice date, which can be weeks after the trial ended, so the charge is not waited for. A trial lasts the days Shopify says the merchant has left, so a returning merchant's shorter trial is right.",
  "**A cancellation counts on the day it takes effect.** When Shopify says a canceled subscription ends later (`cancelEffectiveOn`), it stays paying until then. A trial canceled before it converts is a canceled trial, not churn.",
  "**A plan change is not churn plus a new sale.** Moving to a pricier plan is expansion, to a cheaper paid plan is contraction. Moving to a free plan is churn. Shopify's events do not say which subscription they belong to, so three patterns are read as one plan change: a second subscription while one is open, a cancel naming another plan moments after a new one began, and a cancel followed within ten minutes by a new subscription.",
  "**A frozen subscription is churn**, and unfreezing it is a new subscription (a resume). Shopify freezes an app charge when the store closes or stops paying Shopify.",
  "**A reinstall counts as a new install**, and also as a reinstall.",
  "**A store whose billing account Shopify deactivates still counts as installed** until the app is uninstalled. Shopify deactivates a store's billing account when the store closes, pauses or stops paying Shopify, and reactivates it when the store comes back.",
  "**Losses are split by cause: store inactive or merchant left.** A store counts as deactivated from the moment Shopify deactivates its billing account until Shopify reactivates it or the app is installed again. A paying subscription that ends by a freeze, or by a cancel or an uninstall while the store is deactivated, counts as store inactive. Every other end counts as merchant left, a move to a free plan included. Uninstalls are split the same way. A cancel that takes effect later is judged by the store's state on the day it takes effect. Churned MRR, canceled subscribers and uninstalls stay the totals of both parts, and a free trial that ends is never churn, whatever the cause.",
  "**Usage-only plans are not MRR.** A plan with no flat price adds nothing to MRR; its usage charges count under Charged.",
  "**Uninstall events with no install in the data** (the app was installed before the history starts) count as uninstalls in a period but not against active installs, so a period can show more uninstalls than installs without the stock going negative.",
  "**A subscription ends with the uninstall.** Shopify cancels an app's subscriptions when the app is uninstalled, so a subscription created, changed or unfrozen after a shop uninstalls and before it installs again is ignored (Shopify can send such an event late). The subscriptions of a shop with no install or uninstall in the data yet count as usual: it installed before the history starts.",
  "**Excluded shops count nowhere.** A shop on the Excluded shops list in Settings (your own development stores, test installs, Shopify's review stores) is left out of every number of every app. Its events stay stored and still show in the event log, so taking it off the list brings it back.",
  "**MRR always adds up.** For every app and every day: MRR = MRR the day before + new + expansion - contraction - churned. A test checks it against generated data.",
  "**Rates look at the starting group.** Uninstall rate, subscriber churn, revenue churn and both revenue retention figures take the shops that were there at the first moment of the range and ask what became of exactly those shops by the end. A shop that joins and leaves inside the range was never part of that group, so these rates stay between 0% and 100% (net revenue retention can pass 100% when upgrades outweigh losses). A shop that leaves and comes back inside the range counts as kept.",
  "**A figure with nothing to divide by is shown as n/a**, never as 0% or infinity.",
  "**Cohorts follow their group up to today.** The cohort tables and win-back take a group of shops from the range (those that installed, first paid or uninstalled in it) and follow it to today, so an older range has had more time to show what became of its group.",
  "**At risk is read for now.** MRR set to end, trials ending soon and frozen MRR describe the subscriptions as they stand at the moment you look, whatever the date range.",
]

/** Where the numbers come from, in markdown. */
export const SOURCES =
  "Everything is built from the events Shopify's Partner API reports: installs and uninstalls, subscription changes, charges and earnings. Each event is stored once, as Shopify sent it. From the events the worker rebuilds one record per stay of a shop (install to uninstall), one per period on one plan at one price, and one per free trial. A daily table sums those into what the charts read. The dashboard never asks Shopify for anything itself. See `docs/ARCHITECTURE.md`."

export function renderMetricsDoc(): string {
  const rows = ([...Object.values(METRICS), ...Object.values(COHORT_METRICS), ...Object.values(AT_RISK_METRICS)] as MetricDef[]).map((m) => `| ${m.label} | ${m.description} | ${UNIT[m.format]} | ${BETTER[m.good]} |`)

  return `# Metric definitions

This file is generated from \`lib/analytics/metrics-registry.ts\`, the same list the dashboard's tooltips read. Do not edit it by hand: change the registry and run \`pnpm docs:metrics\`.

## Conventions

${CONVENTIONS.map((c) => `- ${c}`).join("\n")}

## The numbers

| Metric | What it is | Unit | Better when |
| --- | --- | --- | --- |
${rows.join("\n")}

## Where the numbers come from

${SOURCES}
`
}
