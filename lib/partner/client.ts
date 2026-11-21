import { DEFAULT_API_VERSION } from "./query"

// A small client for Shopify's Partner API. Read queries only. The token is sent in
// one header and appears nowhere else: not in errors, not in logs.
//
// Shopify allows four requests a second per API client. Each client here spaces its
// own calls, and a 429 or a 5xx is retried after the pause Shopify asks for.

const MIN_GAP_MS = 300
const MAX_ATTEMPTS = 4
const REQUEST_TIMEOUT_MS = 20_000

export class PartnerApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "PartnerApiError"
  }
}

export type PartnerClient = {
  endpoint: string
  query<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T>
}

export type ClientOptions = {
  partnerId: string
  token: string
  version?: string
  /** Injectable for tests. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export function validatePartnerId(value: string): boolean {
  return /^\d{1,20}$/.test(value.trim())
}

export function validateApiVersion(value: string): boolean {
  return /^(\d{4}-\d{2}|unstable)$/.test(value.trim())
}

export function createPartnerClient(options: ClientOptions): PartnerClient {
  const partnerId = options.partnerId.trim()
  const version = (options.version ?? DEFAULT_API_VERSION).trim()
  if (!validatePartnerId(partnerId)) throw new PartnerApiError("The Partner ID must be a number")
  if (!validateApiVersion(version)) throw new PartnerApiError("The API version looks like 2026-07")

  const { token } = options
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init))
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  const endpoint = `https://partners.shopify.com/${partnerId}/api/${version}/graphql.json`
  let lastCallAt = 0

  /** Short, one line, and never containing the token. */
  const clean = (text: string) => text.split(token).join("[token]").replace(/\s+/g, " ").trim().slice(0, 200)

  async function query<T>(graphql: string, variables: Record<string, unknown>): Promise<T> {
    let lastError: unknown = new PartnerApiError("Partner API request failed")

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const wait = lastCallAt + MIN_GAP_MS - now()
      if (wait > 0) await sleep(wait)
      lastCallAt = now()

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({ query: graphql, variables }),
          signal: controller.signal,
        })

        if (res.status === 429 || res.status >= 500) {
          lastError = new PartnerApiError(`Partner API answered HTTP ${res.status}`, res.status)
          const retryAfter = Number(res.headers.get("retry-after"))
          const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * attempt
          if (attempt < MAX_ATTEMPTS) await sleep(pause)
          continue
        }

        const text = await res.text()
        if (!res.ok) throw new PartnerApiError(`Partner API answered HTTP ${res.status}: ${clean(text)}`, res.status)

        let body: { data?: T; errors?: { message?: string }[] }
        try {
          body = JSON.parse(text)
        } catch {
          throw new PartnerApiError("Partner API answered with something that is not JSON")
        }
        // Shopify can send a GraphQL error with HTTP 200.
        if (Array.isArray(body.errors) && body.errors.length > 0) {
          const messages = body.errors.map((e) => e?.message).filter(Boolean).join("; ")
          // Shopify documents an error for organizations that do not have the events feature yet.
          const hint = /not enabled/i.test(messages)
            ? " Shopify turns its events feature on per Partner organization, and it is not on for this one yet, so nothing can be read until it is."
            : ""
          throw new PartnerApiError(`Partner API error: ${clean(messages || "unknown")}.${hint}`, 200)
        }
        return body.data as T
      } catch (err) {
        if (err instanceof PartnerApiError) throw err
        // A timeout or a dropped connection.
        lastError = err
        if (attempt < MAX_ATTEMPTS) await sleep(1000 * attempt)
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError instanceof Error ? lastError : new PartnerApiError("Partner API request failed")
  }

  return { endpoint, query }
}

export function describeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300)
}
