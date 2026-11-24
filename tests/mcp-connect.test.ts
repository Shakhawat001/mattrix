import { describe, expect, it } from "vitest"
import {
  claudeCodeCommand,
  claudeDesktopConfig,
  codexConfig,
  connectTarget,
  curlTest,
  cursorConfig,
  ENDPOINT_PLACEHOLDER,
  endpointUrl,
  MCP_REMOTE_VERSION,
  openCodeConfig,
  TOKEN_PLACEHOLDER,
  type ProxyTrust,
} from "@/lib/mcp/connect"

const headers = (values: Record<string, string>) => new Headers(values)
const direct: ProxyTrust = { trustProxy: false, proxyHops: 1, cookieSecure: false }
const proxied: ProxyTrust = { trustProxy: true, proxyHops: 1, cookieSecure: true }

describe("endpointUrl", () => {
  it("reads the Host header over plain http when no proxy is trusted", () => {
    expect(endpointUrl(headers({ host: "localhost:3103" }), direct)).toBe("http://localhost:3103/api/mcp")
    expect(endpointUrl(headers({ host: "LOCALHOST:3103", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }), direct)).toBe("http://localhost:3103/api/mcp")
  })

  it("reads the host and scheme a trusted proxy forwards", () => {
    const behind = headers({ host: "web:3000", "x-forwarded-host": "mattrix.apps.batinstudio.com", "x-forwarded-proto": "https" })
    expect(endpointUrl(behind, proxied)).toBe("https://mattrix.apps.batinstudio.com/api/mcp")
    expect(endpointUrl(behind, { ...proxied, cookieSecure: false })).toBe("https://mattrix.apps.batinstudio.com/api/mcp")
    expect(endpointUrl(headers({ host: "metrics.example.com" }), { ...proxied, cookieSecure: false })).toBe("http://metrics.example.com/api/mcp")
  })

  it("counts forwarded entries from the right, as many as there are proxies", () => {
    const chain = headers({ host: "web:3000", "x-forwarded-host": "evil.example, metrics.example.com, metrics.example.com", "x-forwarded-proto": "http, https, https" })
    expect(endpointUrl(chain, { ...proxied, proxyHops: 2, cookieSecure: false })).toBe("https://metrics.example.com/api/mcp")
    // Cloudflare in front of one that overwrites the header: one entry for two proxies.
    expect(endpointUrl(headers({ "x-forwarded-host": "metrics.example.com", "x-forwarded-proto": "https" }), { ...proxied, proxyHops: 2 })).toBe("https://metrics.example.com/api/mcp")
  })

  it("knows the browser is on https when cookies are secure, except on localhost", () => {
    const cookies = { ...direct, cookieSecure: true }
    expect(endpointUrl(headers({ host: "metrics.example.com" }), cookies)).toBe("https://metrics.example.com/api/mcp")
    expect(endpointUrl(headers({ "x-forwarded-host": "metrics.example.com", "x-forwarded-proto": "http" }), proxied)).toBe("https://metrics.example.com/api/mcp")
    expect(endpointUrl(headers({ host: "localhost:3000" }), cookies)).toBe("http://localhost:3000/api/mcp")
    expect(endpointUrl(headers({ host: "127.0.0.1:3000" }), cookies)).toBe("http://127.0.0.1:3000/api/mcp")
    expect(endpointUrl(headers({ host: "[::1]:3000" }), cookies)).toBe("http://[::1]:3000/api/mcp")
  })

  it("drops a default port and writes the host in lower case", () => {
    expect(endpointUrl(headers({ "x-forwarded-host": "Metrics.Example.com:443", "x-forwarded-proto": "https" }), proxied)).toBe("https://metrics.example.com/api/mcp")
    expect(endpointUrl(headers({ host: "192.168.1.20:3000" }), direct)).toBe("http://192.168.1.20:3000/api/mcp")
  })

  it("gives null for a host or a scheme it cannot use, so the guide shows a placeholder", () => {
    for (const host of ["", "evil.example/path", "a b", "$(touch x)", "user@evil.example", "evil.example?x", "-bad.example", "example.com:99999", "`id`"]) {
      expect(endpointUrl(headers(host ? { host } : {}), direct), host).toBeNull()
    }
    expect(endpointUrl(headers({ "x-forwarded-host": "metrics.example.com", "x-forwarded-proto": "ftp" }), { ...proxied, cookieSecure: false })).toBeNull()
  })
})

const ENDPOINT = "https://metrics.example.com/api/mcp"
const TOKEN = `amt_${"A".repeat(43)}`
const target = { url: ENDPOINT, token: TOKEN }

describe("connectTarget", () => {
  it("fills in the endpoint and the token, or placeholders for what is unknown or unsafe to paste", () => {
    expect(connectTarget(ENDPOINT, TOKEN)).toEqual(target)
    expect(connectTarget(null, null)).toEqual({ url: ENDPOINT_PLACEHOLDER, token: TOKEN_PLACEHOLDER })
    expect(connectTarget("https://x.example/api/mcp$(id)", "amt_a b")).toEqual({ url: ENDPOINT_PLACEHOLDER, token: TOKEN_PLACEHOLDER })
    expect(connectTarget(ENDPOINT, 'amt_"; rm -rf ~')).toEqual({ url: ENDPOINT, token: TOKEN_PLACEHOLDER })
  })
})

describe("the setups", () => {
  it("Claude Code: one command that adds the server for every folder", () => {
    expect(claudeCodeCommand(target)).toBe(`claude mcp add --transport http --scope user appmetrics "${ENDPOINT}" --header "Authorization: Bearer ${TOKEN}"`)
  })

  it("Claude Desktop: mcp-remote at a pinned version, with the token in env and no space in the header argument", () => {
    const config = JSON.parse(claudeDesktopConfig(target))
    expect(config).toEqual({
      mcpServers: {
        appmetrics: {
          command: "npx",
          args: ["-y", `mcp-remote@${MCP_REMOTE_VERSION}`, ENDPOINT, "--header", "Authorization:${AUTH_HEADER}"],
          env: { AUTH_HEADER: `Bearer ${TOKEN}` },
        },
      },
    })
    expect(MCP_REMOTE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    for (const arg of config.mcpServers.appmetrics.args) expect(arg).not.toContain(" ")
  })

  it("Claude Desktop: --allow-http only for plain http away from localhost, where mcp-remote refuses it", () => {
    const args = (url: string) => JSON.parse(claudeDesktopConfig({ url, token: TOKEN })).mcpServers.appmetrics.args as string[]
    expect(args("http://localhost:3103/api/mcp")).not.toContain("--allow-http")
    expect(args("http://127.0.0.1:3000/api/mcp")).not.toContain("--allow-http")
    expect(args(ENDPOINT)).not.toContain("--allow-http")
    expect(args("http://192.168.1.20:3000/api/mcp").at(-1)).toBe("--allow-http")
  })

  it("Cursor, OpenCode and Codex: the endpoint with the token in an Authorization header", () => {
    expect(JSON.parse(cursorConfig(target))).toEqual({ mcpServers: { appmetrics: { url: ENDPOINT, headers: { Authorization: `Bearer ${TOKEN}` } } } })
    expect(JSON.parse(openCodeConfig(target))).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { servers: { appmetrics: { type: "remote", url: ENDPOINT, oauth: false, headers: { Authorization: `Bearer ${TOKEN}` } } } },
    })
    expect(codexConfig(target)).toBe(`[mcp_servers.appmetrics]\nurl = "${ENDPOINT}"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN}" }`)
  })

  it("curl: a list_apps call in the 2025 form, which needs no handshake", () => {
    const command = curlTest(target)
    expect(command.split("\n")[0]).toBe(`curl "${ENDPOINT}" \\`)
    expect(command).toContain(`-H "Authorization: Bearer ${TOKEN}"`)
    expect(command).toContain('-H "Accept: application/json, text/event-stream"')
    const body = /-d '(.*)'$/.exec(command)?.[1]
    expect(JSON.parse(body ?? "")).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_apps", arguments: {} } })
  })
})
