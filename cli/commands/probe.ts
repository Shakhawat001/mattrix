import { formatMoney } from "@/lib/format"
import { createPartnerClient, describeError, PartnerApiError } from "@/lib/partner/client"
import { parseEventNode, parseLegacyEventNode, parseTransactionNode, type ParsedEvent } from "@/lib/partner/parse"
import { CORE_EVENT_TYPES, EARNING_EVENT_TYPES, EVENTS_QUERY, LEGACY_EVENT_TYPES, LEGACY_EVENTS_QUERY, partnersAppId, TRANSACTION_TYPES, TRANSACTIONS_QUERY } from "@/lib/partner/query"

// Tries a Partner API token against the live API, read-only, and says what it can see.
// Run it before adding the connection, or when a sync fails and you want to know why.
//
//   PARTNER_ID=123456 PARTNER_API_TOKEN=... pnpm cli probe [days]
//
// The token is read from the environment, never from the command line, so it does not
// end up in your shell history. The output holds counts, amounts and app names, never a shop.

type Edge = { node?: unknown }
type Response = { events?: { edges?: Edge[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }
type LegacyResponse = { app?: { events?: { edges?: { cursor?: unknown; node?: unknown }[]; pageInfo?: { hasNextPage?: boolean } } } | null }
type TransactionsResponse = { transactions?: { edges?: { cursor?: unknown; node?: unknown }[]; pageInfo?: { hasNextPage?: boolean } } | null }

const SALES: ReadonlySet<string> = new Set(["APP_SUBSCRIPTION_SALE", "APP_ONE_TIME_SALE", "APP_USAGE_SALE"])
const money = (cents: number | null) => (cents === null ? "n/a" : formatMoney(cents))

function explain(err: unknown, permission = "Manage apps"): string {
  const status = err instanceof PartnerApiError ? err.status : undefined
  if (status === 401) return "the token was refused. Check it was copied whole and that the client is not revoked."
  if (status === 404) return "not found. Check the Partner ID (the number in your Partner Dashboard URL) and the API version."
  if (status === 403) return `forbidden. The client needs the ${permission} permission.`
  return describeError(err)
}

/** A refusal over permissions: an HTTP 403, or Shopify's GraphQL answer saying access was denied. */
function deniedAccess(err: unknown): boolean {
  return (err instanceof PartnerApiError && err.status === 403) || /access denied|not authorized|permission/i.test(describeError(err))
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
    const sums = { gross: 0, net: 0, fee: 0 }
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
        sums.gross += e.grossCents ?? 0
        sums.net += e.netCents ?? 0
        sums.fee += e.feeCents ?? 0
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
    return { total, byType, apps, uninstalls, withReason, withWords, subscriptions, withPrice, sums }
  }

  /** Shopify's payout ledger, one app at a time: what each sale, credit and adjustment added to or took off the payout. */
  async function readTransactions(appGids: string[]) {
    const rows: ParsedEvent[] = []
    const min = new Date(Date.now() - days * 86_400_000).toISOString()
    const max = new Date().toISOString()
    for (const gid of appGids) {
      let cursor: string | null = null
      let pages = 0
      do {
        const data: TransactionsResponse = await client.query<TransactionsResponse>(TRANSACTIONS_QUERY, {
          appId: partnersAppId(gid),
          types: TRANSACTION_TYPES,
          createdAtMin: min,
          createdAtMax: max,
          cursor,
        })
        if (!data?.transactions) throw new PartnerApiError("Partner API answered without a transactions list")
        const edges = data.transactions.edges ?? []
        for (const edge of edges) {
          const t = parseTransactionNode(edge.node, gid)
          if (t) rows.push(t)
        }
        const last = edges.at(-1)?.cursor
        cursor = data.transactions.pageInfo?.hasNextPage && typeof last === "string" ? last : null
      } while (cursor && ++pages < 40)
    }
    return rows
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
    console.log(`  ${money(earnings.sums.gross)} gross, ${money(earnings.sums.net)} net, Shopify's fee ${money(earnings.sums.fee)}. Shopify documents their net as what is left after its commission.`)
  } catch (err) {
    console.log(`\nEarnings: not readable with this token (${explain(err)})`)
    console.log("  Everything else works without them. Earnings then come from the payout records below, if those can be read.")
  }

  if (core.apps.size === 0) {
    console.log("\nPayout records: no app in this window to read them for.")
  } else {
    try {
      // Oldest first across every app, so "the latest" below are the latest of all.
      const ledger = (await readTransactions([...core.apps.keys()])).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      const byType: Record<string, number> = {}
      for (const t of ledger) byType[t.type] = (byType[t.type] ?? 0) + 1
      const gross = ledger.reduce((sum, t) => sum + (t.grossCents ?? 0), 0)
      const net = ledger.reduce((sum, t) => sum + (t.netCents ?? 0), 0)
      const retained = ledger.reduce((sum, t) => sum + (t.feeCents ?? 0), 0)
      const sales = ledger.filter((t) => SALES.has(t.type) && t.grossCents !== null && t.netCents !== null)
      // What reached the payout below what the merchant paid less shopifyFee: a fee shopifyFee does not
      // name (the processing fee, a regulatory operating fee) is in netAmount. A revenue share alone
      // does not count here, so the check holds on any revenue share plan.
      const withOtherFees = sales.filter((t) => (t.netCents as number) < (t.grossCents as number) - (t.feeCents ?? 0)).length
      console.log(`\nPayout records (Shopify's transactions): readable, ${ledger.length} transactions`)
      for (const [type, n] of Object.entries(byType).sort()) console.log(`  ${String(n).padStart(5)}  ${type}`)
      console.log(`  As sent: ${money(gross)} gross, ${money(net)} to your payouts, ${money(retained)} in shopifyFee (what Shopify says it retained).`)
      console.log(`  Sales whose payout is below gross minus shopifyFee, so it has another fee taken off: ${withOtherFees} of ${sales.length}.`)
      const show = (list: ParsedEvent[]) => list.slice(-5).forEach((t) => console.log(`    ${t.type.padEnd(22)} gross ${money(t.grossCents).padStart(9)}  shopifyFee ${money(t.feeCents).padStart(8)}  to payout ${money(t.netCents).padStart(9)}`))
      if (sales.length > 0) {
        console.log("  The latest sales:")
        show(sales)
      }
      const others = ledger.filter((t) => !SALES.has(t.type))
      if (others.length > 0) {
        console.log("  The latest credits and adjustments, with the signs Shopify sent:")
        show(others)
      }
      if (sales.length > 0 && withOtherFees === 0) {
        console.log("  No sale shows a fee beyond shopifyFee, so these records leave the processing fee out. If the Partner Dashboard shows one, please open an issue.")
      }
    } catch (err) {
      if (deniedAccess(err)) {
        console.log(`\nPayout records: not readable with this token (${explain(err, "View financials")})`)
        console.log("  They need the View financials permission. Without them, net earnings come from the earning events, if the token can read those, and leave out the 2.9% processing fee and any regulatory operating fee.")
      } else {
        console.log(`\nPayout records: could not be read (${explain(err, "View financials")})`)
      }
    }
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
