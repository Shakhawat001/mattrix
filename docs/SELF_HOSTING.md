# Self-hosting

AppMetrics is a Docker Compose project: `web`, `worker` and `db`. These steps work on any machine that runs Docker Compose, and the Coolify notes below cover that platform specifically.

## 1. Get the code

Clone the repository onto the machine, or point Coolify at it.

## 2. Make your secrets

You need a database password, a session secret, an encryption key and a login password. Build the image once, then use it to generate them (nothing is stored):

```bash
docker build -t appmetrics:latest .

# Session secret and encryption key
docker run --rm appmetrics:latest node dist/cli.mjs generate-secrets

# A hash of your password (it asks for the password and does not show it)
docker run --rm -it appmetrics:latest node dist/cli.mjs hash-password

# A database password that needs no escaping
openssl rand -hex 24
```

Put them in `.env` (copy `.env.example`). Prefer `DASHBOARD_PASSWORD_HASH` over `DASHBOARD_PASSWORD`, so the password itself is never in a file. Set exactly one of the two.

Back up `ENCRYPTION_KEY`. Without it the Partner API tokens stored in the database cannot be read, and you would add them again.

## 3. Start it

```bash
docker compose up -d --build
```

The first start creates the database tables. The `web` container is ready when `docker compose ps` shows it healthy. `worker` starts after it.

To try it on your own computer instead, over plain http:

```bash
docker compose -f compose.yaml -f compose.local.yaml up -d --build
```

and open http://localhost:3000. That publishes the port on 127.0.0.1 only.

## 4. Put it behind HTTPS

On a server, never expose `web` over plain http: the login password and the session cookie would travel in the clear. Put a reverse proxy that terminates HTTPS in front of port 3000. The session cookie is marked `Secure`, so signing in over plain http fails on purpose.

Tell the app how many proxies sit in front of it, so it reads the real visitor address for login throttling:

- One proxy (Coolify's, Caddy, nginx, Traefik): `TRUST_PROXY=true`, `PROXY_HOPS=1`. `compose.yaml` sets both. Running the app without Compose, set `TRUST_PROXY=true` yourself: the app leaves it off unless told.
- Cloudflare in front of that proxy: `PROXY_HOPS=2`.
- Directly on the internet with no proxy: `TRUST_PROXY=false`. (Do not do this over http.)

If you set `PROXY_HOPS` too low, every visitor looks like your proxy; if too high, a visitor could pick their own address. When unsure, send a request with a made-up `X-Forwarded-For` header and see which address the sessions table records.

If the dashboard shows "Invalid Server Actions request" after you put it behind a proxy that rewrites the host name, add the public host name to `ALLOWED_ORIGINS` and rebuild (it is read when the image is built).

## 5. Deploy on Coolify

Use `compose.coolify.yaml`. It runs the same services as `compose.yaml`, but Coolify generates every secret, so you skip step 2.

1. Create a new resource from your Git repository and choose the **Docker Compose** build pack. Set the compose file (Docker Compose Location) to `/compose.coolify.yaml`.
2. Coolify generates the database password, the session secret, the encryption key and your login. The one variable you may change is `PROXY_HOPS`: leave it at 1, or set 2 when Cloudflare proxies the domain.
3. Open the `web` service and give it a domain, with port `3000`. Coolify's proxy issues the certificate. Do not give `db` or `worker` a domain.
4. Deploy. Watch the `web` container's log: it starts, or it stops at once with a plain list of what is wrong with the environment.
5. Under **Environment Variables**, read your login: `SERVICE_LOWERCASEUSER_DASHBOARD` is the username and `SERVICE_PASSWORD_DASHBOARD` the password. Copy `SERVICE_REALBASE64_32_ENCRYPTION` into your password manager: without it the stored Partner API tokens cannot be read.

Things to know:

- Coolify cannot make a password hash, so the login password sits in Coolify as it is and is hashed when the app starts. To keep only a hash, use `/compose.yaml` and set the variables from your `.env` yourself.
- If the app stops with an `ENCRYPTION_KEY` error, your Coolify is too old to generate that value. Paste a key from `generate-secrets` into `SERVICE_REALBASE64_32_ENCRYPTION`.
- Switching compose files after a deploy gives the database a new password, but Postgres keeps the old one in its volume. Before any data matters, delete the `db-data` volume and deploy again.

Everything else (the database volume, restarts) is in the compose file. Back up the `db-data` volume.

## 6. Sign in and connect Shopify

Open your domain and sign in with your username and password (on Coolify, the two values from step 5).

The dashboard reads Shopify through the **Partner API**, with one token for your whole Partner organization. Create it in your Partner organization's settings: a Partner API client, with only the permission that lets it read your apps and their events (at the time of writing it is called "Manage apps"; this dashboard sends only read queries). Copy its token. Shopify's own Partner API documentation on shopify.dev has the current steps.

Then in **Settings, Add a connection**:

- **Partner ID**: the number in the address of your Partner Dashboard.
- **Token**: the one you copied. It is encrypted before it is stored, and it is never shown again.
- **Read history from**: how far back to read. Older events are read once, in the background.

The worker starts the first sync within a minute. The connection shows its progress, and a clear error if the token is wrong. Your apps appear as soon as their events arrive. After that the worker syncs every `SYNC_INTERVAL_MINUTES` (default 60), and **Sync now** on the connection asks for one immediately.

Your apps are found by themselves. Rename them, give them a color, or hide one in **Settings, Apps**.

Pick your time zone in **Settings, System**. Days run from midnight to midnight there, and every time is shown on its clock. It is UTC until you pick one. You can change it later: the numbers are rebuilt for the new zone, usually within a minute and longer while a sync is running.

## 7. Day to day

**Update.** Pull the new code and run `docker compose up -d --build`. Migrations run when `web` starts.

**Back up.** The `backup` service does it for you. Every 12 hours it writes a compressed dump of the database to the `db-backups` volume, and it keeps 14 days of dumps (always at least the newest 3). `BACKUP_EVERY_HOURS` and `BACKUP_KEEP_DAYS` change that. The dumps sit on the same server as the database, so they protect you from a bad update or a mistake, not from losing the server: copy them somewhere else now and then with `docker compose cp backup:/backups ./appmetrics-backups`. Everything except the stored tokens, your own settings and your annotations can also be rebuilt from Shopify by connecting again.

- **List the dumps:** `docker compose exec backup ls -lh /backups`. On Coolify, open the `backup` container's terminal and run `ls -lh /backups`.
- **Take one now:** `docker compose exec backup sh -c 'pg_dump --format=custom --file=/backups/appmetrics-manual-$(date -u +%Y%m%d-%H%M%S).dump'`.
- **Restore one:** stop `web` and `worker` first (`docker compose stop web worker`), then `docker compose exec backup pg_restore --clean --if-exists --dbname=appmetrics /backups/<file>.dump`, then `docker compose start web worker`.

**Change the password.** Generate a new hash, change `DASHBOARD_PASSWORD_HASH`, redeploy, then use **Settings, Sign out everywhere**.

**Rotate `SESSION_SECRET`.** Everyone is signed out and every API token stops working; create new tokens in **Settings, API tokens**. Nothing else changes.

**Rotate `ENCRYPTION_KEY`.** The stored tokens can no longer be read. Remove and add the connection again.

**See the log.** `docker compose logs -f web worker`. Lines are JSON, one per event. Tokens are cut out of error messages before they are logged, and passwords are never logged.

## Troubleshooting

- **`web` exits at once.** Its log lists what is wrong with the environment, one line each, without printing any secret.
- **The first sync fails.** The reason is on the connection in Settings. A 401 or 403 means the token or its permission is wrong. Other errors are retried on the next sync.
- **Earnings are empty but everything else works.** The token can read installs and charges but not Shopify's earnings events. The connection says so. Charged amounts and MRR do not depend on them.
- **I cannot sign in and the page just reloads.** You are on plain http against a server. Use https, or for a local test use `compose.local.yaml`.
- **"Too many attempts."** Five wrong passwords from one address in fifteen minutes lock that address out for the rest of the window. While someone is guessing at the account from other addresses, an address that has failed even once also waits; a clean one can still try. After more than 100 failures in an hour from anywhere, every address waits until the count falls. Wait, or clear the record yourself: `docker compose exec db psql -U appmetrics -c "delete from login_attempts"`.
