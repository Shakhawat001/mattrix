# Architecture

## The parts

```
Shopify Partner API
        ^
        | read-only GraphQL, one request at a time, only from here
        |
     worker  ----------->  db (Postgres)  <-----------  web (Next.js)  <-----  your browser
   (syncs, rebuilds)       events, derived tables,       (reads only the       (one login)
                           daily numbers, sessions       database)
```

- **web** serves the dashboard, and the read-only MCP endpoint for AI agents at `/api/mcp` ([MCP.md](MCP.md)). It reads the database and nothing else. It never calls Shopify, so a slow or failing Shopify cannot slow a page down, and the Partner API token is never in the web process's request path.
- **worker** is the only process that talks to Shopify. It syncs on a schedule, or when Settings asks, and keeps the derived tables and daily numbers current. It decrypts a token only to make a request.
- **db** is Postgres 17. It is not published outside the Compose network.
- **backup** uses the same Postgres image to dump the database every 12 hours into its own volume, keeping 14 days. See [SELF_HOSTING.md](SELF_HOSTING.md#7-day-to-day).

Web and worker are the same image with a different command (`docker/entrypoint.sh`).

## Three layers of data

Everything can be rebuilt from the first layer.

1. **Raw `events`.** What the Partner API sent, stored once by Shopify's own event id (or, for the billing screen events that have none, an id made from their content), with the payload kept as sent so a field added later needs no new sync.
2. **Derived `installs`, `subscriptions`, `trials`.** One row per stay of a shop (install to uninstall), per period on one plan at one price, and per free trial. They are rebuilt for an app from its events by one pure function, `derive()` in `lib/analytics/derive.ts`. It takes events, a date and a time zone and returns rows, so it is tested without a database. Each app records the `DERIVE_VERSION` it was built with, and the worker rebuilds any app built with an older one, so a deploy that changes a rule recomputes all of history.
3. **Rollup `daily_metrics`.** One row per app per day in the dashboard's time zone (Settings; UTC until one is picked). Each app records the zone its rows were built in, and the worker rebuilds any app built in another zone than the one Settings names, so changing the zone takes effect on the worker's next pass: usually within a minute, or once a sync that is running finishes. Until then each page shows a notice, and the daily CSV export refuses. Flows (installs, new MRR, charges) are what happened that day and add up over any range. Stocks (active installs, subscribers, MRR) are the value at the end of the day and are read at a date, never added.

The dashboard's numbers come from layer 3, except the ones that need to know about individual shops (retention of the starting group, install and revenue cohorts, win-back, shop list, plan mix, trials, uninstall reasons, what is at risk), which read layer 2.

Three reads serve the pages and AI agents alike. Each takes a database handle or a transaction and returns plain data: one shop's timeline (`lib/analytics/shop-timeline.ts`), how complete the data is (`data-health.ts`), and the shops behind each MRR movement (`mrr-movers.ts`). The last applies the rollup's own rules to the subscription periods, so its amounts add up to the rollup's new, expansion, contraction and churned MRR for any range. A test holds the two side by side.

## Syncing

`lib/partner/sync.ts` reads events in windows of at most 300 days, oldest first, with a three-day overlap so nothing at a window's edge is missed. Duplicates are harmless because events are stored by id. The watermark (where to resume) moves only after a window has been stored completely, so a crash in the middle repeats work and never skips it.

There are four passes, each with its own watermark. The core pass reads installs, subscriptions and charges. A separate earnings pass reads Shopify's earnings events, so a token that cannot read earnings still gives you everything else, and the connection says so.

The third pass reads the payout records: Shopify's `transactions` query (the payout ledger in the code), one app at a time, for app sales, credits and adjustments. Shopify documents a transaction's net as "the net amount that is added to or deducted from your payout", while an earning event's net is "after commission" only. So only the payout records take off the 2.9% processing fee and any regulatory operating fee (the fields that split those out exist only in the unstable API version, so the fees are read as gross minus net). It needs the token's View financials permission. Each transaction is stored as `transaction:` plus Shopify's id, under Shopify's type name (`APP_SUBSCRIPTION_SALE`, `APP_SALE_CREDIT`, ...), filed under the app it was read for; a transaction that names another app stops the pass rather than count another app's money. It reads in 30-day windows, so a busy app stays under the page cap, and re-reads the last forty days on every run: Shopify says a recurring charge can take up to 37 days to appear as an earning ([Track app usage](https://shopify.dev/docs/apps/launch/distribution/track-app-usage)), and the ledger is small. Like the earnings pass, its failure is recorded on the connection and fails nothing else.

The fourth pass reads the billing screen: charges accepted, declined and left to expire, and usage cap events. The newer events API never reports a declined or expired charge, so this pass reads Shopify's older `App.events`, one app at a time: each app the core pass has found, only the chosen ones when the connection names apps. Its failure is recorded on the connection and fails neither the run nor the other passes. These events have no id of their own, so each is stored as `legacy:` plus a SHA-256 of its type, time, shop and charge, and reading one again stores nothing. They keep Shopify's type names, and the whole node (with the charge's test flag) is the payload. `derive()` leaves them out, so they change none of the numbers built from the other events.

Requests are spaced to stay under Shopify's rate limit and retried on rate limits, server errors and network failures. Errors are cleaned of the token before they are stored or logged.

An advisory lock per connection means two workers started by mistake do no harm: the second skips.

## From events to numbers

The rules are written down in [METRICS.md](METRICS.md). The ones that shape the code:

- A plan change is expansion or contraction, not churn plus a new sale.
- MRR is tracked as a running total that must add up every day (`MRR = previous day + new + expansion - contraction - churned`). A test runs this over generated data for every app and day.
- A shop's history is replayed in time order, with ties broken by event type, so an install always lands before its first subscription and an uninstall after its cancel. Events of the same type at the same instant are read in the order of their ids, so every rebuild gives the same result.
- The replay knows whether Shopify has the store's billing account deactivated, so each loss gets a cause: the store went inactive, or the merchant left.
- Earnings come from the payout records up to the point the sync has read them (the connection's ledger watermark), and from the earning events after it. Each moment has one source, so a charge is not counted twice, and a ledger read only partly leaves no day empty. In steady state the watermark is the last sync, so every earning comes from the payout records. The rebuild stores the cutoff it used on the app (`apps.ledger_until`), and every other reader of earnings (a shop's totals and timeline, the Revenue tab's breakdown) follows it (`lib/analytics/earnings.ts`), so they always agree with the rollup.
- Excluded shops (Settings) are left out when an app is rebuilt; their events stay stored. Changing the list marks every app dirty. A rebuild holds a lock on its app's row from reading the events to writing the new rows, so a change made meanwhile waits and marks the app again instead of being lost.

## How a page is built

Every page is a server component. The date range, comparison, bucket size and chosen apps are in the URL; the page reads them, validates them (a bad value falls back to a default, never an error) and loads data. Charts and the filter bar are client components that receive plain data.

Changing a filter pushes a new URL inside a React transition, so the page on screen stays, dimmed, until the new one is ready. There is no loading flash and no layout jump.

The chart code follows three rules: color follows the thing it stands for (an app keeps its color when you filter others out), every chart has a table view with the same numbers, and a figure with nothing to divide by is shown as n/a.

## Code map

```
app/            routes: (auth)/login, (app)/ for everything behind the login, api/
components/     ui/ (shadcn), app/ (shell, filters, tiles), charts/, settings/
lib/analytics/  derive, rebuild, aggregate, queries, matrix, view builders, metric registry,
                shop timeline, data health, MRR movers
lib/partner/    query, client, parse, sync, store
lib/auth/       password, sessions, API tokens, rate limit, cookies, the data access layer
lib/mcp/        the MCP endpoint: token check, rate limit, read-only context, answers, tools/,
                prompts, and the setup Settings shows to connect an AI
lib/db/         schema, client, migrations runner
worker/         the background process
cli/            migrate, seed-demo, generate-secrets, hash-password, check-env, probe
drizzle/        SQL migrations
tests/          unit tests; tests/integration needs Postgres
```

## Tests

Unit tests cover the pure code (the derive engine against a hand-computed history, the KPI maths, ranges and buckets, formatting, CSV, the Partner API client and parser, environment validation, password hashing). Integration tests run the real SQL against Postgres: sessions, API tokens, login throttling, storing events, rebuilding, every query, the retention of the starting group, the demo data's invariants, and the MCP endpoint over HTTP. See [CONTRIBUTING.md](../CONTRIBUTING.md).
