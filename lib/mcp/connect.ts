// What Settings shows to connect an AI app to the MCP endpoint (components/settings/connect-ai.tsx):
// the endpoint's address, read from the request the way the app trusts its proxy, and each app's
// setup with that address and a token filled in. Plain text builders, so what a person pastes into a
// terminal or a config file is tested as text.

export const MCP_PATH = "/api/mcp"
/** The name each app lists the server under. */
export const SERVER_NAME = "appmetrics"
export const ENDPOINT_PLACEHOLDER = "https://YOUR-DASHBOARD-ADDRESS/api/mcp"
export const TOKEN_PLACEHOLDER = "PASTE_YOUR_TOKEN_HERE"
/** The mcp-remote release Claude Desktop runs, pinned so that a new release cannot change it unseen. */
export const MCP_REMOTE_VERSION = "0.16.7"

export type ProxyTrust = { trustProxy: boolean; proxyHops: number; cookieSecure: boolean }

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i

/**
 * Where agents reach the endpoint: the address the browser that asked for this page used, or null
 * when it cannot be told. Behind a trusted proxy (TRUST_PROXY) the host and scheme come from
 * X-Forwarded-Host and X-Forwarded-Proto, read the way lib/auth/client-ip.ts reads X-Forwarded-For;
 * otherwise from the Host header, over plain http, which is all the app serves itself. With secure
 * cookies (COOKIE_SECURE) the browser is on https, or it could not have signed in, except on localhost.
 */
export function endpointUrl(headers: Pick<Headers, "get">, trust: ProxyTrust): string | null {
  const forwarded = (name: string) => (trust.trustProxy ? fromRight(headers.get(name), trust.proxyHops) : null)
  const host = forwarded("x-forwarded-host") ?? headers.get("host")?.trim() ?? ""
  if (!HOST.test(host)) return null
  const scheme = trust.cookieSecure && !isLoopback(host) ? "https" : (forwarded("x-forwarded-proto")?.toLowerCase() ?? "http")
  if (scheme !== "http" && scheme !== "https") return null
  try {
    // Normalized: the host in lower case, without a default port.
    return `${new URL(`${scheme}://${host}`).origin}${MCP_PATH}`
  } catch {
    return null
  }
}

/** The entry the outermost of `hops` proxies wrote, counted from the right; the first one when there are fewer. */
function fromRight(header: string | null, hops: number): string | null {
  const entries = (header ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.length === 0 ? null : entries[Math.max(0, entries.length - hops)]
}

function isLoopback(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase()
  return name === "localhost" || name.endsWith(".localhost") || name === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(name)
}

export type Target = { url: string; token: string }

/** An address or a token pasted into a shell or a config file: no quotes, spaces or $ in it, or it is not used. */
const PLAIN = /^[\w.:/[\]-]+$/

/** The endpoint and token to fill in, with placeholders for what is not known. */
export function connectTarget(endpoint: string | null, token: string | null): Target {
  return {
    url: endpoint !== null && PLAIN.test(endpoint) ? endpoint : ENDPOINT_PLACEHOLDER,
    token: token !== null && PLAIN.test(token) ? token : TOKEN_PLACEHOLDER,
  }
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

/** One line, so it pastes the same into zsh, bash and PowerShell. */
export function claudeCodeCommand({ url, token }: Target): string {
  return `claude mcp add --transport http --scope user ${SERVER_NAME} "${url}" --header "Authorization: Bearer ${token}"`
}

/**
 * Claude Desktop's connector screen cannot send a bearer token, so it runs mcp-remote, which turns the
 * remote endpoint into a local server and adds the header. The header is written without a space,
 * with the token in env, because Claude Desktop on Windows splits arguments at spaces (mcp-remote's
 * README). mcp-remote reads ${AUTH_HEADER} itself, so the token stays out of the process list, and it
 * refuses plain http except to localhost unless told.
 */
export function claudeDesktopConfig({ url, token }: Target): string {
  const args = ["-y", `mcp-remote@${MCP_REMOTE_VERSION}`, url, "--header", "Authorization:${AUTH_HEADER}"]
  if (/^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) args.push("--allow-http")
  return json({ mcpServers: { [SERVER_NAME]: { command: "npx", args, env: { AUTH_HEADER: `Bearer ${token}` } } } })
}

export function cursorConfig({ url, token }: Target): string {
  return json({ mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: `Bearer ${token}` } } } })
}

/** OpenCode's global config. `oauth: false` because the endpoint takes a token and has no sign-in. */
export function openCodeConfig({ url, token }: Target): string {
  return json({ $schema: "https://opencode.ai/config.json", mcp: { servers: { [SERVER_NAME]: { type: "remote", url, oauth: false, headers: { Authorization: `Bearer ${token}` } } } } })
}

/** Codex's config.toml, which the Codex CLI, its IDE extension and the ChatGPT desktop app share. */
export function codexConfig({ url, token }: Target): string {
  return [`[mcp_servers.${SERVER_NAME}]`, `url = "${url}"`, `http_headers = { "Authorization" = "Bearer ${token}" }`].join("\n")
}

/** A tools/call in the 2025 form of the protocol, which needs no handshake. For a terminal on macOS or Linux. */
export function curlTest({ url, token }: Target): string {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_apps", arguments: {} } })
  return [`curl "${url}" \\`, `  -H "Authorization: Bearer ${token}" \\`, `  -H "Content-Type: application/json" \\`, `  -H "Accept: application/json, text/event-stream" \\`, `  -d '${body}'`].join("\n")
}
