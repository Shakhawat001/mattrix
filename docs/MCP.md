# AI agents (MCP)

AppMetrics serves its numbers to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io) at `/api/mcp`, on the same web container as the dashboard. Connect Claude Code, Claude Desktop, Cursor, OpenCode, Codex or any other MCP client, and ask it about your installs, revenue and churn.

The quickest way: in the dashboard, open **Settings**, then **API tokens**, and create a token. **Connect an AI**, just below, has each app's setup with your dashboard's address and that token filled in, ready to copy. The steps here are the same, written out by hand.

It is read-only. An agent can read the numbers the dashboard shows and nothing else: it cannot change data, and it never reaches Shopify. The endpoint speaks MCP revision 2026-07-28 (stateless Streamable HTTP, built on the official TypeScript SDK v2), and also serves clients that still use the 2025 revisions.

## 1. Create a token

1. In the dashboard, open **Settings**, then **API tokens**.
2. Give the token a name (for example "Claude Code on my laptop") and pick when it expires.
3. Tick **Hide shop domains** if the agent should see an alias such as `shop_3f9a1c2b7e` in place of each shop's domain. See [Data use](#data-use).
4. Click **Create token** and copy it. It is shown once; only a hash of it is stored. Until you click **Done**, the setup under **Connect an AI** has it filled in.

The setup in Settings puts the token in each app's config, which keeps it there in plain text. Where an app can read it from the environment, as in the examples below, the token stays out of config files:

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

### Claude Desktop

Claude Desktop's Connectors screen cannot send a bearer token, so Claude Desktop reaches the endpoint through [mcp-remote](https://www.npmjs.com/package/mcp-remote), a small bridge it starts on your computer. It runs on Node.js: install the LTS version from [nodejs.org](https://nodejs.org) first.

1. In Claude Desktop, open **Settings**, then **Developer**, and click **Edit Config**. That opens `claude_desktop_config.json`, which is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows.
2. Add the server under `mcpServers`, next to any that are there already:

   ```json
   {
     "mcpServers": {
       "appmetrics": {
         "command": "npx",
         "args": ["-y", "mcp-remote@0.16.7", "https://<your host>/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
         "env": {
           "AUTH_HEADER": "Bearer amt_..."
         }
       }
     }
   }
   ```

3. Quit Claude Desktop and open it again. Closing the window is not enough: on macOS choose **Claude**, then **Quit Claude**; on Windows right-click the Claude icon in the system tray and choose **Quit**.
4. Click **+** in the message box, then **Connectors**: appmetrics is listed with its tools. If it is not, **Settings**, then **Developer**, shows the error and the server's log.

How this is written, on purpose:

- The mcp-remote version is pinned, so a new release cannot change what runs on your computer unseen. Raise it when you choose to.
- `Authorization:${AUTH_HEADER}` has no space in it, because Claude Desktop on Windows splits arguments at spaces. mcp-remote fills in `${AUTH_HEADER}` from `env` itself, so the token does not show in the list of running processes. It does stay in this file, in plain text.
- mcp-remote refuses plain http except to `localhost` and `127.0.0.1`. For a dashboard on plain http elsewhere, add `"--allow-http"` to `args`, or better, serve it over https.

mcp-remote 0.16.7 was tested against this endpoint: it opens with the 2025 handshake, which the endpoint answers. With `"--protocol", "auto"` added to `args` it finds the 2026-07-28 revision and uses that instead; both work.

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

Tools with a range take a `preset` (such as `last_30_days`, the default) or `from` and `to` (days in the dashboard's time zone, both included), and `app_ids` (default: every app that is not hidden, together). Their numbers equal the dashboard's for the same apps and range. Lists are capped, and each tool's description says where. A tool refuses an argument it does not take, such as `range` for `preset`, and the error lists the ones it does.

Every answer is JSON in the same shape: `range` (when the tool has one), `timezone` (the dashboard's time zone from Settings, such as `"Asia/Dhaka"`, which every day in the answer is a day in; moments are ISO 8601 in UTC), `notes` with the caveats to read first (demo data, a failed sync, earnings that cannot be read, where history starts), then `data`. Money comes as `{ cents, formatted }`, a percentage as `{ ratio, formatted }`, where `formatted` is what the dashboard shows. A figure with nothing to divide by is `null`, never 0. Apps hidden in Settings are left out, as on the dashboard. Text that merchants wrote, such as uninstall comments, only ever appears in fields named `merchant_text_untrusted`, and agents are told to treat it as data, not instructions.

## Prompts

Three ready-made requests. Each tells the agent which tools to call, in what order and with what input, then what to write.

| Prompt | Arguments | What it asks for |
| --- | --- | --- |
| `weekly_review` | none | The last 7 days against the 7 before: MRR and the shops that moved it, installs and uninstalls, churn by cause, what is at risk, and what to do this week. |
| `investigate_churn` | `app`: an app's id or a word from its name (default: every app together). `range`: a preset such as `last_30_days` or `last_month` (default: `last_90_days`), or two days as `2026-08-01..2026-10-31`. | Who left, why and when: churn by cause, the shops behind churned MRR, uninstall reasons and comments, how long shops stayed, win-back, and what to check or change. |
| `at_risk_followup` | none | Who to contact now and why: the subscriptions set to end and the trials ending soon, most urgent first, each with what its history shows and a way to open the conversation. |

Claude Code and OpenCode list them when you type `/appmetrics:`, as `/appmetrics:weekly_review` and so on (Claude Code also takes `/mcp__appmetrics__weekly_review`). Arguments follow the name, separated by spaces: `/appmetrics:investigate_churn show last_30_days`. A range typed on its own is read as the range. In Claude Desktop, the prompts are under **+** in the message box.

## Limits

- Each tool reads in a read-only database transaction, and a query that runs longer than 15 seconds is stopped.
- 120 requests a minute per token. Past that the endpoint answers 429 with a `Retry-After` header. A batch of JSON-RPC messages, which only clients on the 2025-03-26 revision send, counts each message as a request.
- Every request a token makes is written to a call log in the database (the tool or method, whether it succeeded, how long it took), kept for 30 days. Requests refused by the rate limit are not, so a runaway agent cannot fill the table. The token itself is never logged.
- A request sent by a web page (one with an `Origin` header) is refused. Agents such as OpenCode and Claude Code do not send one, and neither does mcp-remote.

If a client cannot connect: 401 means the token is missing, mistyped, revoked or expired; 429 means wait for the number of seconds in `Retry-After`. A 405 for GET is normal: the endpoint only takes POST.

## Data use

Whatever a tool returns goes to the AI provider your agent runs on. Shopify's [API License and Terms of Use](https://www.shopify.com/legal/api-terms) (section 2.3, as updated October 7, 2026) forbid using information derived from Shopify's APIs, including anonymous, aggregate or derived data, to create, train, fine tune or improve machine learning or AI models. Every number here comes from the Partner API, so:

- Connect AI accounts that do not train on your data. Check your provider's data settings and terms before you connect one.
- Tick **Hide shop domains** on the token if you prefer the provider not to see your shops' addresses. The agent still sees the numbers, a stable alias for each shop, and what merchants wrote. Any myshopify.com address anywhere in an answer or an error, in what merchants wrote or in a sync error, is replaced by its alias too. It gives the alias back to look a shop up, and cannot search or sort shops by domain.

The same terms also limit passing data from Shopify to third parties (sections 2.1 and 6.2). Read them for your own case; this page is not legal advice.
