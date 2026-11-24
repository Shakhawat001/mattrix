# AI agents (MCP)

AppMetrics serves its numbers to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io) at `/api/mcp`, on the same web container as the dashboard. Connect OpenCode, Claude Code or any other MCP client, and ask it about your installs, revenue and churn.

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
| `list_apps` | Every app that is not hidden, with the ids the other tools take, the first and last event Shopify reported, and when its numbers were last rebuilt. For each Partner connection: the last sync, the last sync error, and whether its token can read earnings. |
| `get_definitions` | What every number means: the conventions and every metric's definition, from the same registry as the dashboard's tooltips and [METRICS.md](METRICS.md). Or one metric, by its id. |

The resource `appmetrics://definitions` holds the same definitions as markdown. More tools are on the way: see [ROADMAP.md](ROADMAP.md), section 2.3.

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
- Tick **Hide shop domains** on the token if you prefer the provider not to see your shops' addresses. The agent still sees the numbers, a stable alias for each shop, and what merchants wrote, with any myshopify.com address in it replaced by its alias.

The same terms also limit passing data from Shopify to third parties (sections 2.1 and 6.2). Read them for your own case; this page is not legal advice.
