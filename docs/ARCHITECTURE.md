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

- **web** serves the dashboard. It reads the database and nothing else. It never calls Shopify, so a slow or failing Shopify cannot slow a page down, and the Partner API token is never in the web process's request path.
- **worker** is the only process that talks to Shopify. It syncs on a schedule, or when Settings asks, and keeps the derived tables and daily numbers current. It decrypts a token only to make a request.
- **db** is Postgres 17. It is not published outside the Compose network.
- **backup** uses the same Postgres image to dump the database every 12 hours into its own volume, keeping 14 days. See [SELF_HOSTING.md](SELF_HOSTING.md#7-day-to-day).

Web and worker are the same image with a different command (`docker/entrypoint.sh`).

## Three layers of data

Everything can be rebuilt from the first layer.

1. **Raw `events`.** What the Partner API sent, stored once by Shopify's own event id, with the payload kept as sent so a field added later needs no new sync.
2. **Derived `installs`, `subscriptions`, `trials`.** One row per stay of a shop (install to uninstall), per period on one plan at one price, and per free trial. They are rebuilt for an app from its events by one pure function, `derive()` in `lib/analytics/derive.ts`. It takes events and a date and returns rows, so it is tested without a database. Each app records the `DERIVE_VERSION` it was built with, and the worker rebuilds any app built with an older one, so a deploy that changes a rule recomputes all of history.
3. **Rollup `daily_metrics`.** One row per app per UTC day. Flows (installs, new MRR, charges) are what happened that day and add up over any range. Stocks (active installs, subscribers, MRR) are the value at the end of the day and are read at a date, never added.

The dashboard's numbers come from layer 3, except the ones that need to know about individual shops (retention of the starting group, install and revenue cohorts, win-back, shop list, plan mix, trials, uninstall reasons), which read layer 2.

## Syncing

`lib/partner/sync.ts` reads events in windows of at most 300 days, oldest first, with a three-day overlap so nothing at a window's edge is missed. Duplicates are harmless because events are stored by id. The watermark (where to resume) moves only after a window has been stored completely, so a crash in the middle repeats work and never skips it.

There are two passes. The core pass reads installs, subscriptions and charges. A separate earnings pass reads Shopify's earnings events, so a token that cannot read earnings still gives you everything else, and the connection says so.

Requests are spaced to stay under Shopify's rate limit and retried on rate limits, server errors and network failures. Errors are cleaned of the token before they are stored or logged.

An advisory lock per connection means two workers started by mistake do no harm: the second skips.

## From events to numbers

The rules are written down in [METRICS.md](METRICS.md). The ones that shape the code:

- A plan change is expansion or contraction, not churn plus a new sale.
- MRR is tracked as a running total that must add up every day (`MRR = previous day + new + expansion - contraction - churned`). A test runs this over generated data for every app and day.
- A shop's history is replayed in time order, with ties broken by event type, so an install always lands before its first subscription and an uninstall after its cancel.

## How a page is built

Every page is a server component. The date range, comparison, bucket size and chosen apps are in the URL; the page reads them, validates them (a bad value falls back to a default, never an error) and loads data. Charts and the filter bar are client components that receive plain data.

Changing a filter pushes a new URL inside a React transition, so the page on screen stays, dimmed, until the new one is ready. There is no loading flash and no layout jump.

The chart code follows three rules: color follows the thing it stands for (an app keeps its color when you filter others out), every chart has a table view with the same numbers, and a figure with nothing to divide by is shown as n/a.

## Code map

```
app/            routes: (auth)/login, (app)/ for everything behind the login, api/
components/     ui/ (shadcn), app/ (shell, filters, tiles), charts/, settings/
lib/analytics/  derive, rebuild, aggregate, queries, matrix, view builders, metric registry
lib/partner/    query, client, parse, sync, store
lib/auth/       password, sessions, rate limit, cookies, the data access layer
lib/db/         schema, client, migrations runner
worker/         the background process
cli/            migrate, seed-demo, generate-secrets, hash-password, check-env, probe
drizzle/        SQL migrations
tests/          unit tests; tests/integration needs Postgres
```

## Tests

Unit tests cover the pure code (the derive engine against a hand-computed history, the KPI maths, ranges and buckets, formatting, CSV, the Partner API client and parser, environment validation, password hashing). Integration tests run the real SQL against Postgres: sessions, login throttling, storing events, rebuilding, every query, the retention of the starting group, and the demo data's invariants. See [CONTRIBUTING.md](../CONTRIBUTING.md).
