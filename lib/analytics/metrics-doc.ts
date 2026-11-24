import { COHORT_METRICS, METRICS, type MetricDef, type MetricFormat } from "./metrics-registry"

// docs/METRICS.md is written from the registry that the dashboard's own tooltips read, so what
// the page says and what the file says cannot disagree. `pnpm docs:metrics` rewrites the file;
// a test fails when the committed copy is out of date.

const UNIT: Record<MetricFormat, string> = { int: "count", money: "US dollars", percent: "percent", days: "days" }
const BETTER: Record<MetricDef["good"], string> = { up: "higher", down: "lower", none: "neither" }

export function renderMetricsDoc(): string {
  const rows = ([...Object.values(METRICS), ...Object.values(COHORT_METRICS)] as MetricDef[]).map((m) => `| ${m.label} | ${m.description} | ${UNIT[m.format]} | ${BETTER[m.good]} |`)

  return `# Metric definitions

This file is generated from \`lib/analytics/metrics-registry.ts\`, the same list the dashboard's tooltips read. Do not edit it by hand: change the registry and run \`pnpm docs:metrics\`.

## Conventions

- **Days are UTC.** A day runs from 00:00 to 24:00 UTC and every time in the dashboard is shown in UTC. A range includes both of its end days.
- **Money is stored in cents and shown in US dollars.** Shopify charges for apps are in US dollars.
- **Monthly value.** A yearly price counts as a twelfth of itself each month. Every MRR figure uses it.
- **A subscriber is a shop paying for a plan.** A plan priced at $0 is not one, and neither is a free trial until it converts, so MRR leaves trials out (the usual SaaS definition, used by ChartMogul, Baremetrics and Stripe). Trials are counted on their own: In trial, MRR in trial and trial conversion.
- **A trial converts when it ends with the subscription still open**, or earlier if a real charge comes in first. Shopify bills app charges on the merchant's own invoice date, which can be weeks after the trial ended, so the charge is not waited for. A trial lasts the days Shopify says the merchant has left, so a returning merchant's shorter trial is right.
- **A cancellation counts on the day it takes effect.** When Shopify says a canceled subscription ends later (\`cancelEffectiveOn\`), it stays paying until then. A trial canceled before it converts is a canceled trial, not churn.
- **A plan change is not churn plus a new sale.** Moving to a pricier plan is expansion, to a cheaper paid plan is contraction. Moving to a free plan is churn. Shopify's events do not say which subscription they belong to, so three patterns are read as one plan change: a second subscription while one is open, a cancel naming another plan moments after a new one began, and a cancel followed within ten minutes by a new subscription.
- **A frozen subscription is churn**, and unfreezing it is a new subscription (a resume).
- **A reinstall counts as a new install**, and also as a reinstall.
- **A store whose billing account Shopify deactivates still counts as installed** until the app is uninstalled. Shopify reports deactivation separately; it is stored but not yet used.
- **Usage-only plans are not MRR.** A plan with no flat price adds nothing to MRR; its usage charges count under Charged.
- **Uninstall events with no install in the data** (the app was installed before the history starts) count as uninstalls in a period but not against active installs, so a period can show more uninstalls than installs without the stock going negative.
- **MRR always adds up.** For every app and every day: MRR = MRR the day before + new + expansion - contraction - churned. A test checks it against generated data.
- **Rates look at the starting group.** Uninstall rate, subscriber churn, revenue churn and both revenue retention figures take the shops that were there at the first moment of the range and ask what became of exactly those shops by the end. A shop that joins and leaves inside the range was never part of that group, so these rates stay between 0% and 100% (net revenue retention can pass 100% when upgrades outweigh losses). A shop that leaves and comes back inside the range counts as kept.
- **A figure with nothing to divide by is shown as n/a**, never as 0% or infinity.
- **Cohorts follow their group up to today.** The cohort tables and win-back take a group of shops from the range (those that installed, first paid or uninstalled in it) and follow it to today, so an older range has had more time to show what became of its group.

## The numbers

| Metric | What it is | Unit | Better when |
| --- | --- | --- | --- |
${rows.join("\n")}

## Where the numbers come from

Everything is built from the events Shopify's Partner API reports: installs and uninstalls, subscription changes, charges and earnings. Each event is stored once, as Shopify sent it. From the events the worker rebuilds one record per stay of a shop (install to uninstall), one per period on one plan at one price, and one per free trial. A daily table sums those into what the charts read. The dashboard never asks Shopify for anything itself. See \`docs/ARCHITECTURE.md\`.
`
}
