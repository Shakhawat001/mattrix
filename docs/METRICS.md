# Metric definitions

This file is generated from `lib/analytics/metrics-registry.ts`, the same list the dashboard's tooltips read. Do not edit it by hand: change the registry and run `pnpm docs:metrics`.

## Conventions

- **Days are UTC.** A day runs from 00:00 to 24:00 UTC and every time in the dashboard is shown in UTC. A range includes both of its end days.
- **Money is stored in cents and shown in US dollars.** Shopify charges for apps are in US dollars.
- **Monthly value.** A yearly price counts as a twelfth of itself each month. Every MRR figure uses it.
- **A subscriber is a shop paying for a plan.** A plan priced at $0 is not one, and neither is a free trial until it converts, so MRR leaves trials out (the usual SaaS definition, used by ChartMogul, Baremetrics and Stripe). Trials are counted on their own: In trial, MRR in trial and trial conversion.
- **A trial converts when it ends with the subscription still open**, or earlier if a real charge comes in first. Shopify bills app charges on the merchant's own invoice date, which can be weeks after the trial ended, so the charge is not waited for. A trial lasts the days Shopify says the merchant has left, so a returning merchant's shorter trial is right.
- **A cancellation counts on the day it takes effect.** When Shopify says a canceled subscription ends later (`cancelEffectiveOn`), it stays paying until then. A trial canceled before it converts is a canceled trial, not churn.
- **A plan change is not churn plus a new sale.** Moving to a pricier plan is expansion, to a cheaper paid plan is contraction. Moving to a free plan is churn. Shopify's events do not say which subscription they belong to, so three patterns are read as one plan change: a second subscription while one is open, a cancel naming another plan moments after a new one began, and a cancel followed within ten minutes by a new subscription.
- **A frozen subscription is churn**, and unfreezing it is a new subscription (a resume).
- **A reinstall counts as a new install**, and also as a reinstall.
- **A store whose billing account Shopify deactivates still counts as installed** until the app is uninstalled. Shopify reports deactivation separately; it is stored but not yet used.
- **Usage-only plans are not MRR.** A plan with no flat price adds nothing to MRR; its usage charges count under Charged.
- **Uninstall events with no install in the data** (the app was installed before the history starts) count as uninstalls in a period but not against active installs, so a period can show more uninstalls than installs without the stock going negative.
- **MRR always adds up.** For every app and every day: MRR = MRR the day before + new + expansion - contraction - churned. A test checks it against generated data.
- **Rates look at the starting group.** Uninstall rate, subscriber churn, revenue churn and both revenue retention figures take the shops that were there at the first moment of the range and ask what became of exactly those shops by the end. A shop that joins and leaves inside the range was never part of that group, so these rates stay between 0% and 100% (net revenue retention can pass 100% when upgrades outweigh losses). A shop that leaves and comes back inside the range counts as kept.
- **A figure with nothing to divide by is shown as n/a**, never as 0% or infinity.

## The numbers

| Metric | What it is | Unit | Better when |
| --- | --- | --- | --- |
| Active installs | Shops that have the app installed at the end of the period. | count | higher |
| New installs | Installs during the period. A shop that comes back counts again. | count | higher |
| Reinstalls | Installs by a shop that had installed the app before. | count | higher |
| Uninstalls | Uninstall events during the period. | count | lower |
| Net installs | Installs minus uninstalls. | count | higher |
| Uninstall rate | Of the shops that had the app at the start of the period, the share that no longer has it at the end. Shops that installed during the period are not counted, so it stays between 0% and 100%. | percent | lower |
| Subscribers | Shops paying for a plan at the end of the period. A free trial is not counted until it converts. | count | higher |
| In trial | Shops on a free trial of a paid plan at the end of the period. They become subscribers when the trial ends with the subscription still open. | count | higher |
| New subscribers | Shops that started paying during the period: a subscription with no trial, a trial that converted, a move off a free plan, or a resumed subscription. | count | higher |
| Canceled subscribers | Paying subscriptions that ended during the period, by cancel, uninstall or freeze, or by a move to a free plan. A trial that ends without paying is counted under trials, not here. | count | lower |
| MRR | Monthly recurring revenue at the end of the period: the price of every paying subscription, with a yearly price divided by twelve. Free trials are left out until they convert. | US dollars | higher |
| MRR in trial | What the free trials running at the end of the period would add to MRR if every one of them converted. | US dollars | higher |
| ARR | Annual run rate: the MRR at the end of the period times twelve. | US dollars | higher |
| MRR change | MRR at the end of the period minus MRR at its start. | US dollars | higher |
| New MRR | MRR from shops that started paying during the period, including trials that converted. | US dollars | higher |
| Expansion MRR | MRR added by existing subscribers moving to a pricier plan. | US dollars | higher |
| Contraction MRR | MRR lost to existing subscribers moving to a cheaper paid plan. | US dollars | lower |
| Churned MRR | MRR lost when paying subscriptions ended by cancel, uninstall or freeze, or moved to a free plan. A cancel counts on the day it takes effect. | US dollars | lower |
| Net new MRR | New plus expansion, minus contraction and churned MRR. It equals the MRR change. | US dollars | higher |
| Net revenue retention | What the subscribers you had at the start of the period pay at the end, over what they paid at the start. It counts upgrades, downgrades and cancels, and leaves out anyone who joined later. Above 100% means upgrades outweighed losses. | percent | higher |
| Gross revenue retention | The same without credit for upgrades: how much of the starting MRR you kept, at most what each subscriber paid at the start. It cannot exceed 100%. | percent | higher |
| Subscriber churn | Of the paying subscribers you had at the start of the period, the share that no longer pays at the end. Subscribers who joined during the period are not counted, so it stays between 0% and 100%. | percent | lower |
| Revenue churn | The share of the starting MRR that was gone by the end, counting cancels and downgrades of the subscribers you had at the start. It is 100% minus gross revenue retention. | percent | lower |
| ARPU | Average revenue per paying subscriber per month: MRR divided by subscribers. | US dollars | higher |
| Lifetime value (estimate) | ARPU divided by subscriber churn per month, with churn over the range restated per 30 days. A rough estimate that moves a lot with small samples; treat it as a direction, not a promise. | US dollars | higher |
| Trials started | Free trials that began during the period. | count | higher |
| Trials converted | Trials that turned into a paying subscription during the period: the trial ended with the subscription still open, or an earlier charge came in. | count | higher |
| Trials canceled | Trials that ended in a cancel, an uninstall or a freeze before the subscription started paying. | count | lower |
| Trial to paid | Trials converted divided by trials converted plus canceled, in the period. Trials still running are left out. | percent | higher |
| Charged | What merchants were charged, before Shopify's fees, by the date of the charge. | US dollars | higher |
| Gross earnings | Earnings before Shopify's fee, as Shopify reports them (refunds and adjustments are included, with their sign). | US dollars | higher |
| Net earnings | What reaches you after Shopify's fee. Needs a token that can read earnings. | US dollars | higher |
| Shopify fees | The revenue share Shopify kept from your charges, as its earnings events report it. | US dollars | lower |
| Fee rate | Shopify's fees divided by gross earnings. | percent | lower |
| Refunded | Value of charges refunded to merchants during the period. | US dollars | lower |
| Credits applied | Value of app credits applied for merchants during the period. | US dollars | lower |

## Where the numbers come from

Everything is built from the events Shopify's Partner API reports: installs and uninstalls, subscription changes, charges and earnings. Each event is stored once, as Shopify sent it. From the events the worker rebuilds one record per stay of a shop (install to uninstall), one per period on one plan at one price, and one per free trial. A daily table sums those into what the charts read. The dashboard never asks Shopify for anything itself. See `docs/ARCHITECTURE.md`.
