import { createPartnerClient, describeError, PartnerApiError } from "@/lib/partner/client"
import { parseEventNode, parseLegacyEventNode } from "@/lib/partner/parse"
import { CORE_EVENT_TYPES, EARNING_EVENT_TYPES, EVENTS_QUERY, LEGACY_EVENT_TYPES, LEGACY_EVENTS_QUERY, partnersAppId } from "@/lib/partner/query"

// Tries a Partner API token against the live API, read-only, and says what it can see.
// Run it before adding the connection, or when a sync fails and you want to know why.
//
//   PARTNER_ID=123456 PARTNER_API_TOKEN=... pnpm cli probe [days]
//
// The token is read from the environment, never from the command line, so it does not
// end up in your shell history. The output holds counts and app names, never a shop.

type Edge = { node?: unknown }
type Response = { events?: { edges?: Edge[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }
type LegacyResponse = { app?: { events?: { edges?: { cursor?: unknown; node?: unknown }[]; pageInfo?: { hasNextPage?: boolean } } } | null }

function explain(err: unknown): string {
  const status = err instanceof PartnerApiError ? err.status : undefined
  if (status === 401) return "the token was refused. Check it was copied whole and that the client is not revoked."
  if (status === 404) return "not found. Check the Partner ID (the number in your Partner Dashboard URL) and the API version."
  if (status === 403) return "forbidden. The client needs the Manage apps permission."
  return describeError(err)
}

export async function probeCommand(args: string[]): Promise<number> {
  const partnerId = process.env.PARTNER_ID
  const token = process.env.PARTNER_API_TOKEN
  if (!partnerId || !token) {
    console.error("Set PARTNER_ID and PARTNER_API_TOKEN in the environment.")
    return 1
  }
  const days = Number(args[0] ?? 90)
  const client = createPartnerClient({ partnerId, token, version: process.env.PARTNER_API_VERSION })
  console.log(`Partner ${partnerId}, reading the last ${days} days`)

  async function read(types: readonly string[]) {
    const byType: Record<string, number> = {}
    const apps = new Map<string, { name: string | null; apiKey: string | null; events: number }>()
    let total = 0
    let uninstalls = 0
    let withReason = 0
    let withWords = 0
    let subscriptions = 0
    let withPrice = 0
    let cursor: string | null = null
    let pages = 0
    const min = new Date(Date.now() - days * 86_400_000).toISOString()
    const max = new Date().toISOString()

    do {
      const data: Response = await client.query<Response>(EVENTS_QUERY, {
        filter: { subjectType: "APP", eventTypes: types, occurredAtMin: min, occurredAtMax: max },
        cursor,
      })
      for (const edge of data.events?.edges ?? []) {
        const e = parseEventNode(edge.node)
        if (!e) continue
        total++
        byType[e.type] = (byType[e.type] ?? 0) + 1
        if (e.appGid) {
          const app = apps.get(e.appGid) ?? { name: e.appName, apiKey: e.appApiKey, events: 0 }
          app.events++
          apps.set(e.appGid, app)
        }
        if (e.type === "RELATIONSHIP_UNINSTALLED") {
          uninstalls++
          if (e.reason) withReason++
          if (e.reasonDescription) withWords++
        }
        if (e.type.startsWith("SUBSCRIPTION_")) {
          subscriptions++
          if (e.amountCents !== null) withPrice++
        }
      }
      const info = data.events?.pageInfo
      cursor = info?.hasNextPage ? (info.endCursor ?? null) : null
    } while (cursor && ++pages < 40)
    return { total, byType, apps, uninstalls, withReason, withWords, subscriptions, withPrice }
  }

  /** The billing screen events of the older App.events, one app at a time. */
  async function readLegacy(appGids: string[]) {
    const byType: Record<string, number> = {}
    let total = 0
    let tests = 0
    const min = new Date(Date.now() - days * 86_400_000).toISOString()
    const max = new Date().toISOString()

    for (const gid of appGids) {
      let cursor: string | null = null
      let pages = 0
      do {
        const data: LegacyResponse = await client.query<LegacyResponse>(LEGACY_EVENTS_QUERY, {
          appId: partnersAppId(gid),
          types: LEGACY_EVENT_TYPES,
          occurredAtMin: min,
          occurredAtMax: max,
          cursor,
        })
        if (!data?.app) throw new PartnerApiError(`Partner API found no app ${partnersAppId(gid)}`)
        const edges = data.app.events?.edges ?? []
        for (const edge of edges) {
          const e = parseLegacyEventNode(edge.node, gid)
          if (!e) continue
          total++
          byType[e.type] = (byType[e.type] ?? 0) + 1
          if ((e.payload.charge as { test?: unknown } | null | undefined)?.test === true) tests++
        }
        const last = edges.at(-1)?.cursor
        cursor = data.app.events?.pageInfo?.hasNextPage && typeof last === "string" ? last : null
      } while (cursor && ++pages < 40)
    }
    return { total, tests, byType }
  }

  let core
  try {
    core = await read(CORE_EVENT_TYPES)
  } catch (err) {
    console.error(`\nFAILED: ${explain(err)}`)
    return 1
  }

  console.log(`\nInstalls, plans and charges: ${core.total} events`)
  for (const [type, n] of Object.entries(core.byType).sort()) console.log(`  ${String(n).padStart(5)}  ${type}`)
  console.log("\nApps in the organization, from their events:")
  if (core.apps.size === 0) console.log("  none in this window. Try a longer one: pnpm cli probe 365")
  for (const [gid, app] of core.apps) console.log(`  ${app.name ?? "(unnamed)"}  ${gid}  ${app.events} events`)
  console.log(`\nUninstalls: ${core.uninstalls}; ${core.withReason} carry a reason; ${core.withWords} carry the merchant's own words`)
  console.log(`Subscription events: ${core.subscriptions}; ${core.withPrice} carry a price`)

  try {
    const earnings = await read(EARNING_EVENT_TYPES)
    console.log(`\nEarnings: readable, ${earnings.total} events`)
  } catch (err) {
    console.log(`\nEarnings: not readable with this token (${explain(err)})`)
    console.log("  Everything else works without them; only the payout numbers stay empty.")
  }

  if (core.apps.size === 0) {
    console.log("\nBilling screen events: no app in this window to read them for.")
  } else {
    try {
      const legacy = await readLegacy([...core.apps.keys()])
      console.log(`\nBilling screen events (the older App.events): ${legacy.total} events, ${legacy.tests} of them for test charges`)
      for (const [type, n] of Object.entries(legacy.byType).sort()) console.log(`  ${String(n).padStart(5)}  ${type}`)
    } catch (err) {
      console.log(`\nBilling screen events: could not be read (${explain(err)})`)
      console.log("  Everything else works without them; only charges declined and expired stay unknown.")
    }
  }
  console.log("\nDone. Nothing was written anywhere.")
  return 0
}
