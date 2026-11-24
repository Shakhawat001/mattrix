# Contributing

Thanks for helping. Bug reports with a way to reproduce, and fixes, are the most useful things. For a larger change, open an issue first so we agree on the direction.

The project is licensed under the GNU Affero General Public License, version 3 only (see LICENSE). By sending a contribution you agree that it is licensed under the same terms, and that the author may also license it, with the rest of the project, under other terms, for example to a company that wants a commercial license instead of the AGPL.

## Set up

You need Node 22 or newer, pnpm (the version in `package.json` is picked up by corepack) and Docker for a Postgres.

```bash
pnpm install

# A throwaway Postgres
docker run -d --name appmetrics-dev-db -e POSTGRES_USER=appmetrics -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=appmetrics -p 127.0.0.1:5432:5432 postgres:17-alpine

cp .env.example .env.local
# In .env.local set:
#   DATABASE_URL=postgres://appmetrics:dev@127.0.0.1:5432/appmetrics
#   DASHBOARD_PASSWORD=<12 or more characters>
#   SESSION_SECRET and ENCRYPTION_KEY from:  pnpm cli generate-secrets
#   COOKIE_SECURE=false      (plain http on localhost)
#   DEMO_MODE=true

pnpm exec tsx --env-file=.env.local cli/index.ts migrate
pnpm exec tsx --env-file=.env.local cli/index.ts seed-demo
pnpm dev
```

Open http://localhost:3000. `d` toggles dark mode.

## Checks

```bash
pnpm typecheck
pnpm test                         # unit tests, no database needed

# Integration tests run the real SQL. They need an empty database of their own:
docker run -d --rm --name appmetrics-test-db -e POSTGRES_USER=appmetrics -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=appmetrics_test -p 127.0.0.1:55433:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://appmetrics:test@127.0.0.1:55433/appmetrics_test pnpm test
```

Without `TEST_DATABASE_URL` the integration tests are skipped, not failed. They wipe the tables of whatever database they point at, so never point them at a real one.

`pnpm build` builds the web server and the worker and CLI bundles. `docs/METRICS.md` is generated: after changing a definition in `lib/analytics/metrics-registry.ts`, run `pnpm docs:metrics`. A test fails if the file is stale.

## Changing the database

Edit `lib/db/schema.ts`, then `pnpm db:generate` and commit the new SQL in `drizzle/`. Migrations only add: new tables, and new columns that are nullable or have a default. `events` is never dropped or rewritten. Derived and rollup tables can be rebuilt from `events`, so a change to how a number is computed needs no data migration: bump `DERIVE_VERSION` in `lib/analytics/derive.ts` and the worker rebuilds every app after the deploy.

## Changing a number

The metric rules in [docs/METRICS.md](docs/METRICS.md) are the contract. A change to one needs a test with a history worked out by hand, in `tests/derive.test.ts` for the event rules or `tests/aggregate.test.ts` for the arithmetic, and a bump of `DERIVE_VERSION` if what `derive()` returns changes. If a result surprises you, write down by hand what it should be before deciding which side is wrong.

## Style

- Plain, direct English in the UI, the docs and the commit messages. Short sentences.
- Never ship a chart color that was not checked. Series colors are the eight hues in `app/globals.css`, in that order; do not add a ninth or reorder them.
- A number with nothing to divide by is `null`, shown as n/a, never 0 or NaN.
- Anything that reads or changes data starts with `requireSession()`, even when the page around it is already behind the login. The MCP endpoint checks its API token instead (`lib/mcp/auth.ts`).
- Never log a token, a password or a session. If you add a log line near one, add a test.
