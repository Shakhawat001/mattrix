<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## This project

AppMetrics is a self-hosted, read-only metrics dashboard for Shopify app developers. Read `README.md` first, then `docs/ARCHITECTURE.md` and `docs/METRICS.md` (generated: `pnpm docs:metrics`).

- Check with `pnpm typecheck`, `pnpm lint` and `pnpm test`. Integration tests need `TEST_DATABASE_URL` (see `CONTRIBUTING.md`) and wipe that database.
- Money is cents. Days are UTC `YYYY-MM-DD` strings. A figure with nothing to divide by is `null`, shown as n/a, never 0 or NaN.
- Anything that reads or changes data calls `requireSession()` itself. The proxy only checks that a cookie exists, and a layout is not a gate either (Next.js can render a page without its layouts), so pages read apps through `getApps()` / `requireVisibleApp()`, which check the session, and every page also calls `requireSession()`. The one exception is the MCP endpoint, `/api/mcp`: it checks its API token instead (`lib/mcp/auth.ts`), and its tools read only through `ctx.read()`, a read-only transaction (`lib/mcp/context.ts`).
- Raw SQL (`db.execute`) returns timestamps as text, because Drizzle turns the driver's date parsing off. Read them with `lib/db/timestamps.ts`.
- Rates such as churn and retention look at the shops that were there at the start of the range (`getRetention`), never at flows divided by a starting stock.
- Never print or log a token, a password or a session. The Partner API is read-only: queries, never mutations.
- Chart colors are the eight `--series-N` hues in `app/globals.css`, in that order, one per thing (an app keeps its color when others are filtered out). Do not add a ninth.
- `compose.coolify.yaml` is `compose.yaml` with Coolify's generated secrets. A change to one compose file goes into both.
- Plain, direct English in the UI, docs and commits. No em dashes.
