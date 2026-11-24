# Security

AppMetrics holds a token that can read your Shopify Partner organization, and a record of your shops. It is a single-user tool, but it sits on the internet, so it is built to be safe by default.

## Reporting a problem

Please report a vulnerability privately, not in a public issue. Use the repository's private security advisory form, or email the maintainer. Include what you found and how to reproduce it. A fix comes first and an announcement after.

## What it does

**Login**
- One username and password from the environment. The password is compared in constant time, and a wrong username takes the same time as a wrong password, so neither can be guessed from timing.
- Prefer `DASHBOARD_PASSWORD_HASH` (scrypt). A plain `DASHBOARD_PASSWORD` is hashed in memory at start.
- The app refuses to start with a missing, short or low-variety secret, and says what is wrong without printing the value.
- Throttling is kept in the database. One address gets 5 failures per 15 minutes, and an IPv6 address counts as its whole /64, the block one home or server usually has to rotate through. When a username has had 5 failures, or the whole site 30 in an hour, from any mix of addresses, the account counts as under attack, and each address then gets only its first try, so a few wrong guesses at your username cannot lock you out. Past 100 failures in an hour nobody may try, you included, until the count falls. That bounds how many guesses even a large botnet gets, at the price of locking you out during an attack that big.
- Each attempt is recorded before the password is checked, then judged with itself counted, so guesses sent at the same moment count against each other instead of all seeing a clean record.
- The client address is read from `X-Forwarded-For` by counting proxies from the right (`PROXY_HOPS`), so a visitor cannot choose their own address. When the header has fewer entries than that, or the entry is not an address, the address is treated as unknown; nothing the client wrote is used instead. The header is read only when `TRUST_PROXY` is on. The app leaves it off unless told; `compose.yaml` turns it on, because there the app can only be reached through the proxy.

**Sessions**
- The cookie holds a random token. The database stores only an HMAC of it, so a copy of the database cannot be turned into a login.
- Sessions end after 24 hours without use, or 7 days in all. You can end them all from Settings.
- The cookie is `HttpOnly`, `SameSite=Lax`, `Secure`, and uses the `__Host-` prefix over https.

**API tokens and the MCP endpoint**
- For AI agents. A token is `amt_` and 256 random bits, shown once, when it is created. The database stores only an HMAC of it, keyed with `SESSION_SECRET` as sessions are, so a copy of the database cannot be turned into a token. Changing `SESSION_SECRET` ends every token, as it ends every session.
- A token expires after 30, 90 or 365 days, or never, as chosen when it is created, and can be revoked in Settings at any moment. At most 20 are active at once. Its last use is recorded, at most once a minute.
- Only the MCP endpoint, `/api/mcp`, accepts tokens, and only as `Authorization: Bearer <token>`. A token in the URL is ignored, because URLs end up in logs. A missing, unknown, revoked or expired token gets 401 with a `WWW-Authenticate: Bearer` challenge. A request with an `Origin` header, which means a web page sent it, gets 403. See [docs/MCP.md](docs/MCP.md).
- Read-only by construction: every tool reads inside a `READ ONLY` database transaction, so a write fails even if a tool had a bug, and each statement in it stops after 15 seconds. The endpoint never calls Shopify. Apps hidden in Settings are left out, as on the dashboard.
- At most 120 requests a minute per token, counted in memory. Past that the answer is 429 with `Retry-After`.
- Every request a token makes goes into a call log: the tool or method, whether it succeeded, and how long it took, kept for 30 days. Requests refused by the rate limit are not logged, so a runaway agent cannot fill the table. The token is never logged, and an error a tool hits stays in the server log; the agent gets a generic message.
- A token can be set to hide shop domains. Every shop domain in its answers is then replaced by `shop_` and the first 10 hex characters of an HMAC of the domain, keyed with `SESSION_SECRET`: the same alias every time, which the tools also take as input. myshopify.com addresses inside text merchants wrote are replaced too. This keeps the addresses from the agent and its AI provider; the numbers, and what merchants wrote, still reach them.
- Text merchants wrote, such as uninstall comments, is only ever sent in fields named `merchant_text_untrusted`, and agents are told to treat it as data, never as instructions, since anyone can install an app and write anything there.

**Access control**
- Next.js's proxy only checks that a cookie exists, so it is a convenience, not a gate. A layout is not a gate either: Next.js can render a page without running the layouts above it. The session is therefore checked against the database in the data layer every page reads through, at the top of every page, in every Server Action and in every route handler. The one exception is `/api/mcp`, which needs no cookie and checks its API token instead. An app id in a URL is only read through the list of apps that are not hidden.
- A page's database query is stopped after 30 seconds, so slow requests cannot hold the connection pool.
- Server Actions check the request's `Origin` (Next.js does this), and validate every input with a schema before using it.
- CSV exports require a session, only cover apps that are not hidden, and make text safe for spreadsheets (a cell starting with `=`, `+`, `-` or `@` is prefixed so it is not run as a formula).

**Secrets**
- Partner API tokens are encrypted with AES-256-GCM before they are stored, and decrypted only inside the worker to make a request. They are never sent to a browser, and error messages are cleaned of them before they are stored or logged.
- No secret is ever printed by the app or its commands.
- The worker only sends read queries to Shopify.

**The web**
- A strict Content-Security-Policy with a fresh nonce per request, no `unsafe-eval` in production, and framing denied. Other headers: `nosniff`, a strict referrer policy, `Permissions-Policy`, cross-origin isolation, HSTS, and `noindex`.
- `/api/health` answers without a login and says only whether the database is reachable.

**The containers**
- Run as a non-root user, with a read-only filesystem, all capabilities dropped and `no-new-privileges`.
- The database is on the Compose network only and is not published to the host.

## What you need to do

- Serve it over https. Never over plain http on a server.
- Choose a long password, or better a hash of one, and keep `SESSION_SECRET` and `ENCRYPTION_KEY` private and backed up.
- Set `PROXY_HOPS` to the number of proxies in front of the app.
- Give the Partner API client the smallest permission that lets it read your apps.
- Treat the database and its backups as sensitive: they hold your shops' domains and the comments merchants wrote when they uninstalled.
- Keep the image updated.

## What it does not do

- There is no second factor. If someone learns your password they are in. Use a long one.
- There is one user. There are no roles.
- An API token is a bearer token: whoever holds it can read your numbers until it expires or is revoked. Keep it in an environment variable or a password manager, not in a file you commit.
- The app and the worker connect to Postgres as the database's owner, which in the bundled container is a superuser. No SQL injection is known (every value is passed as a parameter), but a separate, less privileged role would limit the damage of one. It is planned.
- Anyone who can read the environment variables of the containers can read the secrets, and with `ENCRYPTION_KEY` and the database, the tokens. Protect the host and your deployment platform's account accordingly.
- It cannot protect the Partner API token from Shopify's side: if the token leaks, delete the client in your Partner organization.
