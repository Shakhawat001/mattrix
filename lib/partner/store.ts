import { asc, eq, inArray, sql } from "drizzle-orm"
import type { Db } from "@/lib/db/client"
import { apps, connections, events } from "@/lib/db/schema"
import type { ParsedEvent } from "./parse"
import type { SyncStore } from "./sync"

const CHUNK = 500

/** The sync's storage for one connection, backed by Postgres. */
export function createDbSyncStore(db: Db, connectionId: string): SyncStore {
  return {
    async watermarks() {
      const [row] = await db
        .select({
          core: connections.coreWatermark,
          earnings: connections.earningsWatermark,
          transactions: connections.transactionsWatermark,
          legacy: connections.legacyWatermark,
        })
        .from(connections)
        .where(eq(connections.id, connectionId))
      return { core: row?.core ?? null, earnings: row?.earnings ?? null, transactions: row?.transactions ?? null, legacy: row?.legacy ?? null }
    },
    async setWatermark(pass, at) {
      const column = {
        core: { coreWatermark: at },
        earnings: { earningsWatermark: at },
        transactions: { transactionsWatermark: at },
        legacy: { legacyWatermark: at },
      }[pass]
      await db.update(connections).set(column).where(eq(connections.id, connectionId))
    },
    insertEvents: (list) => insertEvents(db, connectionId, list),
    async appGids() {
      const rows = await db.select({ gid: apps.gid }).from(apps).where(eq(apps.connectionId, connectionId)).orderBy(asc(apps.gid))
      return rows.map((r) => r.gid)
    },
  }
}

/**
 * Files each event under its app (creating the app the first time it appears),
 * stores the ones not seen before, and marks the apps that gained events so their
 * derived tables are rebuilt. All or nothing.
 */
export async function insertEvents(db: Db, connectionId: string, list: ParsedEvent[]): Promise<{ inserted: number }> {
  if (list.length === 0) return { inserted: 0 }

  return db.transaction(async (tx) => {
    const seen = new Map<string, { name: string | null; apiKey: string | null; first: Date; last: Date }>()
    for (const e of list) {
      if (!e.appGid) continue
      const known = seen.get(e.appGid)
      seen.set(e.appGid, {
        name: e.appName ?? known?.name ?? null,
        apiKey: e.appApiKey ?? known?.apiKey ?? null,
        first: known && known.first < e.occurredAt ? known.first : e.occurredAt,
        last: known && known.last > e.occurredAt ? known.last : e.occurredAt,
      })
    }

    const appRows = await tx
      .insert(apps)
      .values(
        [...seen].map(([gid, a]) => ({
          connectionId,
          gid,
          name: a.name ?? gid,
          apiKey: a.apiKey,
          firstEventAt: a.first,
          lastEventAt: a.last,
        })),
      )
      .onConflictDoUpdate({
        target: [apps.connectionId, apps.gid],
        set: {
          // Keep a real name once we have one; a bare id is only a placeholder.
          name: sql`CASE WHEN excluded.name <> excluded.gid THEN excluded.name ELSE apps.name END`,
          apiKey: sql`coalesce(excluded.api_key, apps.api_key)`,
          firstEventAt: sql`least(apps.first_event_at, excluded.first_event_at)`,
          lastEventAt: sql`greatest(apps.last_event_at, excluded.last_event_at)`,
        },
      })
      .returning({ id: apps.id, gid: apps.gid })
    const appIdByGid = new Map(appRows.map((r) => [r.gid, r.id]))

    const rows = list.flatMap((e) => {
      const appId = e.appGid ? appIdByGid.get(e.appGid) : undefined
      return appId
        ? [
            {
              id: e.id,
              appId,
              type: e.type,
              occurredAt: e.occurredAt,
              shop: e.shop,
              shopGid: e.shopGid,
              state: e.state,
              reason: e.reason,
              reasonDescription: e.reasonDescription,
              planHandle: e.planHandle,
              billingPeriod: e.billingPeriod,
              trialDays: e.trialDays,
              trialDaysRemaining: e.trialDaysRemaining,
              cancelEffectiveOn: e.cancelEffectiveOn,
              amountCents: e.amountCents,
              currency: e.currency,
              grossCents: e.grossCents,
              netCents: e.netCents,
              feeCents: e.feeCents,
              chargeId: e.chargeId,
              payload: e.payload,
            },
          ]
        : []
    })

    let inserted = 0
    const touched = new Set<string>()
    for (let i = 0; i < rows.length; i += CHUNK) {
      const added = await tx
        .insert(events)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoNothing()
        .returning({ appId: events.appId })
      inserted += added.length
      for (const row of added) touched.add(row.appId)
    }
    if (touched.size > 0) await tx.update(apps).set({ dirty: true }).where(inArray(apps.id, [...touched]))
    return { inserted }
  })
}
