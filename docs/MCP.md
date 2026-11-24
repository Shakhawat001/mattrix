# AI agents (MCP)

AppMetrics serves its numbers to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io) at `/api/mcp`, on the same web container as the dashboard. Connect OpenCode, Claude Code, Cursor, Codex or any other MCP client, and ask it about your installs, revenue and churn.

It is read-only. An agent can read the numbers the dashboard shows and nothing else: it cannot change data, and it never reaches Shopify. The endpoint speaks MCP revision 2026-07-28 (stateless Streamable HTTP, built on the official TypeScript SDK v2), and also serves clients that still use the 2025 revisions.

## 1. Create a token

1. In the dashboard, open **Settings**, then **API tokens**.
2. Give the token a name (for example "Claude Code on my laptop") and pick when it expires.
3. Tick **Hide shop domains** if the agent should see an alias such as `shop_3f9a1c2b7e` in place of each shop's domain. See [Data use](#data-use).
4. Click **Create token** and copy it. It is shown once; only a hash of it is stored.

Keep the token in an environment variable, so it stays out of config files:

```bash
export APPMETRICS_TOKEN=amt_...   # in your shell profile, or load it from a password manager
```

Send it only in the `Authorization` header. The endpoint never reads a token from the URL, because URLs end up in logs. Revoke a token in Settings and the next request with it is refused.

## 2. Connect your agent

In each example, replace `<your host>` with the address of your dashboard.

### OpenCode

Add a remote server under `mcp.servers` in `opencode.json` (globally in `~/.config/opencode/opencode.json`, or in a project):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "appmetrics": {
        "type": "remote",
        "url": "https://<your host>/api/mcp",
        "oauth": false,
        "headers": {
          "Authorization": "Bearer {env:APPMETRICS_TOKEN}"
        }
      }
    }
  }
}
```

`{env:APPMETRICS_TOKEN}` is read from your environment when OpenCode connects. `"oauth": false` tells OpenCode the server takes a token in a header and has no sign-in. Run `opencode mcp list` to check that it shows as connected. OpenCode opens with the 2025 handshake unless you add `"protocol": "auto"`; the endpoint answers both.

### Claude Code

```bash
claude mcp add --transport http --scope user appmetrics https://<your host>/api/mcp \
  --header 'Authorization: Bearer ${APPMETRICS_TOKEN}'
```

The single quotes keep `${APPMETRICS_TOKEN}` as written: Claude Code reads the variable each time it connects, so the token is not saved in `~/.claude.json`. Leave out `--scope user` to add the server to the current project only. Run `claude mcp list`, or `/mcp` inside Claude Code, to check that it is connected.

### Cursor

Add the server to `~/.cursor/mcp.json` for every project, or to `.cursor/mcp.json` in one project:

```json
{
  "mcpServers": {
    "appmetrics": {
      "url": "https://<your host>/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:APPMETRICS_TOKEN}"
      }
    }
  }
}
```

Cursor fills in `${env:APPMETRICS_TOKEN}` from your environment, so the token stays out of the file. Check under **Customize** in the sidebar that the server is on and lists its tools; connection errors are in the Output panel, under MCP Logs. Cursor's hosted Cloud Agents do not read this file.

### Codex

```bash
codex mcp add appmetrics --url https://<your host>/api/mcp --bearer-token-env-var APPMETRICS_TOKEN
```

This writes the server to `~/.codex/config.toml`, which the Codex CLI, the IDE extension and the ChatGPT desktop app share. You can also write it there by hand:

```toml
[mcp_servers.appmetrics]
url = "https://<your host>/api/mcp"
bearer_token_env_var = "APPMETRICS_TOKEN"
```

Codex reads the token from `APPMETRICS_TOKEN` when it connects, so it is not saved in the file. Run `codex mcp list`, or `/mcp` in a session, to check that it is connected.

### Any client, by hand (curl)

```bash
curl https://<your host>/api/mcp \
  -H "Authorization: Bearer $APPMETRICS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_apps","arguments":{}}}'
```

This is a request in the 2025 form of the protocol, which needs no handshake here. The answer comes as one server-sent event: an `event: message` line, then `data:` and the JSON-RPC result. A client on revision 2026-07-28 also sends the `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method` and `Mcp-Name` headers and a `_meta` object in `params`, and gets plain JSON back:

```bash
curl https://<your host>/api/mcp \
  -H "Authorization: Bearer $APPMETRICS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

## What an agent can read

| Tool | What it returns |
| --- | --- |
| `list_apps` | The apps that are not hidden, with the ids the other tools take, and each connection's last sync, its errors and whether its token can read earnings. |
| `get_definitions` | What every number means: the conventions and each metric's definition, from the registry behind the dashboard's tooltips and [METRICS.md](METRICS.md). |
| `get_metrics` | Any metric for a range, optionally compared with the period or the year before: value, previous value, change and definition. |
| `get_timeseries` | Chosen metrics by day, week or month across a range, for the apps together or each app on its own. |
| `explain_mrr_change` | MRR at the start and end of a range, the new, expansion, contraction and churned MRR between them, and the largest moves behind each, by shop. |
| `get_churn` | Churn numbers and their split by cause, uninstall reasons, merchants' comments, how long installs lasted, and win-back. |
| `get_trials` | The trial numbers for a range, what became of the trials that started in it, and the open trials ending soonest. |
| `get_retention` | Revenue retention and churn rates with the starting group behind them, install cohorts and revenue cohorts. |
| `list_shops` | Every shop with its status, plan, MRR and all it was charged, filtered, sorted and paged, at most 100 a page. |
| `get_shop_timeline` | One shop in one app: where it stands, its totals, every stay, subscription period and trial, and its latest events. |
| `get_at_risk` | The overview's at-risk lists, read for now: paying subscriptions set to end and when, trials ending in the next 7 days, and frozen subscriptions that may come back, each with its MRR. |
| `get_data_health` | How complete the data is: events by type and month, signs of gaps, each connection's syncs, and how many apps are hidden. |

The resource `appmetrics://definitions` holds the same definitions as markdown. Still to come: `list_events`, and `list_annotations` once that feature lands (see [ROADMAP.md](ROADMAP.md), section 2.3).

Tools with a range take a `preset` (such as `last_30_days`, the default) or `from` and `to` (UTC days, both included), and `app_ids` (default: every app that is not hidden, together). Their numbers equal the dashboard's for the same apps and range. Lists are capped, and each tool's description says where. A tool refuses an argument it does not take, such as `range` for `preset`, and the error lists the ones it does.

Every answer is JSON in the same shape: `range` (when the tool has one), `timezone` (always `"UTC"`), `notes` with the caveats to read first (demo data, a failed sync, earnings that cannot be read, where history starts), then `data`. Money comes as `{ cents, formatted }`, a percentage as `{ ratio, formatted }`, where `formatted` is what the dashboard shows. A figure with nothing to divide by is `null`, never 0. Apps hidden in Settings are left out, as on the dashboard. Text that merchants wrote, such as uninstall comments, only ever appears in fields named `merchant_text_untrusted`, and agents are told to treat it as data, not instructions.

## Limits

- Each tool reads in a read-only database transaction, and a query that runs longer than 15 seconds is stopped.
- 120 requests a minute per token. Past that the endpoint answers 429 with a `Retry-After` header.
- Every request a token makes is written to a call log in the database (the tool or method, whether it succeeded, how long it took), kept for 30 days. Requests refused by the rate limit are not, so a runaway agent cannot fill the table. The token itself is never logged.
- A request sent by a web page (one with an `Origin` header) is refused. Agents such as OpenCode and Claude Code do not send one.

If a client cannot connect: 401 means the token is missing, mistyped, revoked or expired; 429 means wait for the number of seconds in `Retry-After`. A 405 for GET is normal: the endpoint only takes POST.

## Data use

Whatever a tool returns goes to the AI provider your agent runs on. Shopify's [API License and Terms of Use](https://www.shopify.com/legal/api-terms) (section 2.3, as updated October 7, 2026) forbid using information derived from Shopify's APIs, including anonymous, aggregate or derived data, to create, train, fine tune or improve machine learning or AI models. Every number here comes from the Partner API, so:

- Connect AI accounts that do not train on your data. Check your provider's data settings and terms before you connect one.
- Tick **Hide shop domains** on the token if you prefer the provider not to see your shops' addresses. The agent still sees the numbers, a stable alias for each shop, and what merchants wrote. Any myshopify.com address anywhere in an answer or an error, in what merchants wrote or in a sync error, is replaced by its alias too. It gives the alias back to look a shop up, and cannot search or sort shops by domain.

The same terms also limit passing data from Shopify to third parties (sections 2.1 and 6.2). Read them for your own case; this page is not legal advice.
