# Roadmap

What we build next, in order. Written 24 November 2026. Tick an item in the same commit that ships it.

## Where it stands

- Live at mattrix.apps.batinstudio.com, syncing Batin Studio's Partner organization (Show Discount and Auto Media Optimizer) with real data.
- The engine is sound: raw events stored once, `derive()` rebuilds the facts, a daily rollup feeds the charts, and every number is defined once in the metric registry. What is missing is depth (numbers a founder acts on) and a way for AI agents to read the data.

## Decisions

- Self-hosted first. A hosted version comes later, after a legal read of Shopify's API Terms: they limit passing Shopify data to third parties, forbid using merchant information for competitive benchmarking, and forbid training AI on API data, even aggregated.
- Core numbers and the MCP server come first. Accounts, billing and the hosted version come after. No marketing work for now.
- Every feature ships as its own commit (or a few), pushed to `main` once the checks pass.

## Rules for every change

- Checks before every push: `pnpm typecheck`, `pnpm lint`, `pnpm test` with `TEST_DATABASE_URL` set (so the integration tests run), and `pnpm build`.
- Migrations only add: new tables, and new columns that are nullable or have a default. `events`, the raw layer everything is rebuilt from, is never dropped or rewritten.
- A change to how numbers are derived bumps `DERIVE_VERSION`, so every app is rebuilt on the next worker run.
- A new number goes into `lib/analytics/metrics-registry.ts` first, then `pnpm docs:metrics`.
- A change to how a number is computed needs a test with a history worked out by hand.
- Money is cents. Days are UTC. Nothing to divide by is null, shown as n/a.
- Read-only toward Shopify: queries, never mutations. Every new Partner API query is checked against the schema of the version it targets before it ships, because one unknown field fails the whole sync.
- Never log a token, a password or a session.
- A change to one compose file goes into both (`compose.yaml`, `compose.coolify.yaml`). New settings are optional with safe defaults, so the live instance keeps running without changes.

## Phase 1: core numbers

### 1.1 Rebuild when the rules change

- [x] `DERIVE_VERSION` in `lib/analytics/derive.ts`, stored per app. The worker rebuilds any app built with an older version, so a deploy that changes a rule recomputes history.

### 1.2 Exclude shops

- [ ] A list of shops left out of every number: your own development stores, test installs, Shopify's review stores. Their events stay stored; the derived tables and rollups skip them.
- [ ] Managed in Settings, and one click from the shop list.

### 1.3 Churn by cause

- [ ] Use `RELATIONSHIP_DEACTIVATED` and `RELATIONSHIP_REACTIVATED` (stored, unused until now) and frozen subscriptions to split losses into "the merchant left" and "the store closed or stopped paying Shopify".
- [ ] New numbers: deactivations, reactivations, churned MRR and canceled subscribers by cause. Shown on the churn page.

### 1.4 At risk

- [ ] Keep each subscription's scheduled end (`SUBSCRIPTION_CANCELLATION_SCHEDULED` with `cancelEffectiveOn`) in the derived table.
- [ ] "MRR at risk": subscriptions set to end, with the date and the shop. Trials ending in the next 7 days. Frozen subscriptions that may come back.
- [ ] Shown on the overview and on each app's overview, as lists to act on.

### 1.5 Charges by kind, usage and tiered prices

- [ ] Charged split into recurring, one-time and usage.
- [ ] Tiered plan prices and the usage fields Shopify sends are read and kept.

### 1.6 Billing screen funnel

- [ ] A third sync pass reads Shopify's older `App.events` for what the newer events API leaves out: charges accepted, declined and expired, and usage cap events.
- [ ] New numbers: charges declined, charges expired, approval rate.

### 1.7 Shop timeline

- [ ] One page per shop per app: every stay, trial, plan change, charge and uninstall (with the merchant's words), in order.

### 1.8 Revenue cohorts and win-back

- [ ] Cohorts by month of first payment: how much MRR each cohort still pays, month by month.
- [ ] Win-back: shops that uninstalled and came back, and how long it took.

### 1.9 Annotations

- [ ] Mark a date, for all apps or one: a price change, a release, an App Store feature, an ad campaign. Shown on the time charts and readable over MCP.

### 1.10 Data health

- [ ] One page that says how complete the data is: events per type per month, uninstalls with no install, subscriptions with no price, sync history and errors.

### 1.11 Later in this phase, depending on what the real data shows

- [ ] Discounts and pending plan changes from `activeSubscription` (apps on Shopify App Pricing only).
- [ ] A full reader on the older API for organizations where Shopify has not turned on the events feature.
- [ ] A funnel per install cohort: install, trial, first payment, still paying at months 1, 3 and 6.

## Phase 2: MCP server and API tokens

### 2.1 Data for agents

- [ ] Shared reads the MCP and the pages both use: one shop's timeline, data health, and the shops behind each MRR movement.

### 2.2 API tokens

- [ ] Create, list and revoke tokens in Settings. Shown once, stored as an HMAC, read-only, with the time of last use. Optional per token: hide shop domains behind stable aliases.

### 2.3 MCP endpoint

- [ ] `/api/mcp` on the web container: official TypeScript SDK v2, MCP spec 2026-07-28 (stateless Streamable HTTP), bearer token.
- [ ] Every tool runs in a read-only database transaction with a short statement timeout. A rate limit per token. A log of every call.
- [ ] Tools: `list_apps`, `get_metrics`, `get_timeseries`, `explain_mrr_change`, `get_retention`, `get_churn`, `get_trials`, `list_shops`, `get_shop_timeline`, `list_events`, `get_data_health`, `get_definitions`. Then `get_at_risk` and `list_annotations` once those features land.
- [ ] Every answer states its range, that days are UTC, and its caveats. Merchant-written text is marked as untrusted. Results are capped and paged.
- [ ] A resource with the metric definitions, and prompts for a weekly review and a churn investigation.

### 2.4 Docs

- [ ] `docs/MCP.md`: connecting OpenCode, Claude Code, Cursor and Codex, and a note on AI data use.

## Phase 3: digest and alerts

- [ ] A weekly digest and instant alerts to Slack, Discord or email: the MRR change and why, new scheduled cancellations, uninstall comments, uninstall spikes. Written from templates, no AI.
- [ ] Outgoing webhooks for the same events.

## Phase 4: where installs come from

- [ ] Read the GA4 property the App Store listing sends traffic to: listing visits, install clicks, search terms, conversion.
- [ ] Later: match each install to its search term and to the revenue that shop became (GA4 BigQuery export).

## Phase 5: accounts and a hosted version

- [ ] The legal read first (see Decisions).
- [ ] Accounts with Better Auth: sign-up, verification, password reset, 2FA, invites, roles, API keys, and OAuth for MCP (claude.ai and ChatGPT connectors need it).
- [ ] Tenancy: an organization id on every table, required in every query, with row-level security as a backstop.
- [ ] Jobs on a Postgres queue (pg-boss), an encryption key per customer, billing through a Merchant of Record, staging, monitoring, tested backups, legal pages, guided onboarding.
- [ ] The final name, before any of this goes public. "AppMetrics" is close to Yandex's AppMetrica.

## How the work runs

Three streams in parallel, each in its own git worktree, each pushing finished features to `main`:

- **Agents:** 2.1, 2.2, 2.3, 2.4.
- **Numbers:** 1.1 to 1.6 (they change `derive()`, the sync and the rollup, so they run in order).
- **Views:** 1.8 and 1.9 first, then 1.7 and 1.10 on top of the reads from 2.1.

## Not planned

- App Store keyword rankings, competitor tracking and review scraping. Other tools already do it, and it depends on scraping instead of Shopify's API.
- Benchmarks across customers. Shopify's API Terms forbid using merchant information for competitive benchmarking.
