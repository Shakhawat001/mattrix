import { describeError, PartnerApiError, type PartnerClient } from "./client"
import { parseEventNode, type ParsedEvent } from "./parse"
import { CORE_EVENT_TYPES, EARNING_EVENT_TYPES, EVENTS_QUERY } from "./query"

// Reads the events of one connection into a store. The rules live here and the
// storage lives behind SyncStore, so the paging, the windows and the watermarks can
// be tested without a database.
//
//   - Two passes, each with its own watermark: the core events, then earnings. A
//     failing earnings pass is recorded and does not fail the run.
//   - Each pass walks windows of at most 300 days (the API allows 365), oldest
//     first, and moves its watermark only after a window is fully stored. A crash or
//     an error mid-window re-reads that window and loses nothing.
//   - Each run starts three days before the watermark. Events carry Shopify's own id,
//     so the overlap costs nothing and catches an event Shopify recorded late.

const DAY_MS = 86_400_000
const WINDOW_MS = 300 * DAY_MS
const OVERLAP_MS = 3 * DAY_MS
const MAX_PAGES_PER_WINDOW = 400

export interface SyncStore {
  watermarks(): Promise<{ core: Date | null; earnings: Date | null }>
  setWatermark(pass: "core" | "earnings", at: Date): Promise<void>
  /** Stores the events not seen before. Returns how many were new. */
  insertEvents(events: ParsedEvent[]): Promise<{ inserted: number }>
}

export type SyncResult = {
  ok: boolean
  inserted: number
  appsSeen: number
  error?: string
  earningsError?: string | null
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

export async function syncConnection(options: SyncOptions): Promise<SyncResult> {
  const { client, store, backfillFrom, now = new Date(), maxPages = MAX_PAGES_PER_WINDOW } = options
  const targets: (string | null)[] = options.appGids?.length ? options.appGids : [null]
  const appsSeen = new Set<string>()
  let inserted = 0

  async function pass(types: readonly string[], which: "core" | "earnings"): Promise<void> {
    const marks = await store.watermarks()
    const saved = marks[which]
    const from = saved ? saved.getTime() - OVERLAP_MS : backfillFrom.getTime()

    for (let start = from; start < now.getTime(); ) {
      const end = Math.min(start + WINDOW_MS, now.getTime())

      for (const gid of targets) {
        let cursor: string | null = null
        let pages = 0
        do {
          const data: EventsResponse = await client.query<EventsResponse>(EVENTS_QUERY, {
            filter: {
              subjectType: "APP",
              ...(gid ? { subjectId: gid } : {}),
              eventTypes: types,
              occurredAtMin: new Date(start).toISOString(),
              occurredAtMax: new Date(end).toISOString(),
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
          if (batch.length > 0) inserted += (await store.insertEvents(batch)).inserted

          const info = connection.pageInfo
          cursor = info?.hasNextPage ? (info.endCursor ?? null) : null
          if (info?.hasNextPage && !cursor) throw new PartnerApiError("Partner API did not return a cursor for the next page")
          if (++pages >= maxPages && cursor) throw new PartnerApiError("Partner API paging did not finish")
        } while (cursor)
      }

      await store.setWatermark(which, new Date(end))
      start = end
    }
  }

  try {
    await pass(CORE_EVENT_TYPES, "core")

    let earningsError: string | null = null
    try {
      await pass(EARNING_EVENT_TYPES, "earnings")
    } catch (err) {
      earningsError = describeError(err)
    }
    return { ok: true, inserted, appsSeen: appsSeen.size, earningsError }
  } catch (err) {
    return { ok: false, inserted, appsSeen: appsSeen.size, error: describeError(err) }
  }
}
