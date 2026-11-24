import { describeError, PartnerApiError, type PartnerClient } from "./client"
import { parseEventNode, parseLegacyEventNode, type ParsedEvent } from "./parse"
import { CORE_EVENT_TYPES, EARNING_EVENT_TYPES, EVENTS_QUERY, LEGACY_EVENT_TYPES, LEGACY_EVENTS_QUERY, partnersAppId } from "./query"

// Reads the events of one connection into a store. The rules live here and the
// storage lives behind SyncStore, so the paging, the windows and the watermarks can
// be tested without a database.
//
//   - Three passes, each with its own watermark: the core events, then earnings, then
//     the billing screen events of the older App.events, one known app at a time. A
//     failing earnings or legacy pass is recorded and does not fail the run.
//   - Each pass walks windows of at most 300 days (the newer API allows 365), oldest
//     first, and moves its watermark only after a window is fully stored. A crash or
//     an error mid-window re-reads that window and loses nothing.
//   - Each run starts three days before the watermark. Events carry Shopify's own id, or
//     for the older API an id made from what they say, so the overlap costs nothing and
//     catches an event Shopify recorded late.

const DAY_MS = 86_400_000
const WINDOW_MS = 300 * DAY_MS
const OVERLAP_MS = 3 * DAY_MS
const MAX_PAGES_PER_WINDOW = 400

export type SyncPass = "core" | "earnings" | "legacy"

export interface SyncStore {
  watermarks(): Promise<Record<SyncPass, Date | null>>
  setWatermark(pass: SyncPass, at: Date): Promise<void>
  /** Stores the events not seen before. Returns how many were new. */
  insertEvents(events: ParsedEvent[]): Promise<{ inserted: number }>
  /** The apps found so far, by gid. */
  appGids(): Promise<string[]>
}

export type SyncResult = {
  ok: boolean
  inserted: number
  appsSeen: number
  error?: string
  earningsError?: string | null
  legacyError?: string | null
}

export type SyncOptions = {
  client: PartnerClient
  store: SyncStore
  backfillFrom: Date
  /** Read only these apps. Empty means every app in the organization. */
  appGids?: string[]
  now?: Date
  maxPages?: number
}

type Edge = { node?: unknown }
type EventsResponse = { events?: { edges?: Edge[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }
type LegacyEdge = { cursor?: unknown; node?: unknown }
type LegacyResponse = { app?: { events?: { edges?: LegacyEdge[]; pageInfo?: { hasNextPage?: boolean } } } | null }

export async function syncConnection(options: SyncOptions): Promise<SyncResult> {
  const { client, store, backfillFrom, now = new Date(), maxPages = MAX_PAGES_PER_WINDOW } = options
  const targets: (string | null)[] = options.appGids?.length ? options.appGids : [null]
  const appsSeen = new Set<string>()
  let inserted = 0

  /** Walks the windows from the pass's watermark to now, moving the watermark after each one is read in full. */
  async function pass(which: SyncPass, readWindow: (min: string, max: string) => Promise<void>): Promise<void> {
    const marks = await store.watermarks()
    const saved = marks[which]
    const from = saved ? saved.getTime() - OVERLAP_MS : backfillFrom.getTime()

    for (let start = from; start < now.getTime(); ) {
      const end = Math.min(start + WINDOW_MS, now.getTime())
      await readWindow(new Date(start).toISOString(), new Date(end).toISOString())
      await store.setWatermark(which, new Date(end))
      start = end
    }
  }

  /** Reads one list to its end. `readPage` stores a page and returns the cursor of the next one, or null. */
  async function readPages(readPage: (cursor: string | null) => Promise<string | null>): Promise<void> {
    let cursor: string | null = null
    let pages = 0
    do {
      cursor = await readPage(cursor)
      if (++pages >= maxPages && cursor) throw new PartnerApiError("Partner API paging did not finish")
    } while (cursor)
  }

  async function keep(batch: ParsedEvent[]): Promise<void> {
    if (batch.length > 0) inserted += (await store.insertEvents(batch)).inserted
  }

  const readEvents = (types: readonly string[]) => async (min: string, max: string) => {
    for (const gid of targets) {
      await readPages(async (cursor) => {
        const data: EventsResponse = await client.query<EventsResponse>(EVENTS_QUERY, {
          filter: {
            subjectType: "APP",
            ...(gid ? { subjectId: gid } : {}),
            eventTypes: types,
            occurredAtMin: min,
            occurredAtMax: max,
          },
          cursor,
        })
        const connection = data?.events
        if (!connection || !Array.isArray(connection.edges)) {
          throw new PartnerApiError("Partner API answered without an events list")
        }

        const batch: ParsedEvent[] = []
        for (const edge of connection.edges) {
          const event = parseEventNode(edge?.node)
          if (!event || !event.appGid) continue // an event with no app cannot be filed anywhere
          appsSeen.add(event.appGid)
          batch.push(event)
        }
        await keep(batch)

        const info = connection.pageInfo
        const next = info?.hasNextPage ? (info.endCursor ?? null) : null
        if (info?.hasNextPage && !next) throw new PartnerApiError("Partner API did not return a cursor for the next page")
        return next
      })
    }
  }

  const readLegacyEvents = (apps: string[]) => async (min: string, max: string) => {
    for (const gid of apps) {
      await readPages(async (cursor) => {
        const data: LegacyResponse = await client.query<LegacyResponse>(LEGACY_EVENTS_QUERY, {
          appId: partnersAppId(gid),
          types: LEGACY_EVENT_TYPES,
          occurredAtMin: min,
          occurredAtMax: max,
          cursor,
        })
        if (!data?.app) throw new PartnerApiError(`Partner API found no app ${partnersAppId(gid)}`)
        const connection = data.app.events
        if (!connection || !Array.isArray(connection.edges)) {
          throw new PartnerApiError("Partner API answered without an app events list")
        }

        const batch: ParsedEvent[] = []
        for (const edge of connection.edges) {
          const event = parseLegacyEventNode(edge?.node, gid)
          if (event) batch.push(event)
        }
        await keep(batch)

        const last = connection.edges.at(-1)?.cursor
        const next = connection.pageInfo?.hasNextPage ? (typeof last === "string" && last ? last : null) : null
        if (connection.pageInfo?.hasNextPage && !next) throw new PartnerApiError("Partner API did not return a cursor for the next page")
        return next
      })
    }
  }

  try {
    await pass("core", readEvents(CORE_EVENT_TYPES))

    let earningsError: string | null = null
    try {
      await pass("earnings", readEvents(EARNING_EVENT_TYPES))
    } catch (err) {
      earningsError = describeError(err)
    }

    // The apps the core pass has found, in this run or before, within the chosen ones.
    let legacyError: string | null = null
    try {
      const chosen = options.appGids?.length ? new Set(options.appGids) : null
      const apps = (await store.appGids()).filter((gid) => !chosen || chosen.has(gid))
      await pass("legacy", readLegacyEvents(apps))
    } catch (err) {
      legacyError = describeError(err)
    }
    return { ok: true, inserted, appsSeen: appsSeen.size, earningsError, legacyError }
  } catch (err) {
    return { ok: false, inserted, appsSeen: appsSeen.size, error: describeError(err) }
  }
}
