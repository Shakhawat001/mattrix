import { and, eq, lt, sql } from "drizzle-orm"
import { rebuildStaleApps } from "@/lib/analytics/rebuild"
import { purgeOldApiCalls } from "@/lib/auth/api-tokens"
import { purgeExpiredSessions } from "@/lib/auth/sessions"
import { createDatabase, type Database } from "@/lib/db/client"
import { runMigrations } from "@/lib/db/migrate"
import { connections, syncRuns } from "@/lib/db/schema"
import { getEnv, type Env } from "@/lib/env"
import { log } from "@/lib/log"
import { createPartnerClient, describeError } from "@/lib/partner/client"
import { createDbSyncStore } from "@/lib/partner/store"
import { syncConnection } from "@/lib/partner/sync"
import { decryptToken } from "@/lib/secrets"

// The background process. It pulls new events from Shopify for every connection on a
// schedule (or when asked from the Settings page), rebuilds the derived tables, and
// tidies up. The web server never calls Shopify; this is the only thing that does.
//
// Two copies running by mistake are harmless: each sync holds a Postgres advisory lock
// on its connection, and the second copy skips it.

const POLL_MS = 15_000
const HOUSEKEEPING_MS = 3_600_000
const KEEP_RUNS_DAYS = 90

type ConnectionRow = typeof connections.$inferSelect

let stopping = false
let wake: (() => void) | undefined

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    wake = () => {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function syncOne(database: Database, connection: ConnectionRow, trigger: "startup" | "schedule" | "manual"): Promise<void> {
  const { db, sql: pg } = database
  // The lock belongs to a session, so it is taken and released on one reserved connection.
  const held = await pg.reserve()
  try {
    const [{ locked }] = await held<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${"appmetrics-sync-" + connection.id})) as locked`
    if (!locked) return

    try {
      const startedAt = new Date()
      // Stamped first, so a crash mid-sync does not turn into a retry loop.
      await db.update(connections).set({ lastRunAt: startedAt, syncRequestedAt: null }).where(eq(connections.id, connection.id))
      const [run] = await db.insert(syncRuns).values({ connectionId: connection.id, trigger, startedAt }).returning({ id: syncRuns.id })

      let ok = false
      let inserted = 0
      let appsFound = 0
      let error: string | null = null
      let earningsError: string | null = null
      let legacyError: string | null = null

      try {
        const client = createPartnerClient({
          partnerId: connection.partnerId,
          token: decryptToken(connection.tokenCiphertext),
          version: connection.apiVersion,
        })
        const result = await syncConnection({
          client,
          store: createDbSyncStore(db, connection.id),
          backfillFrom: connection.backfillFrom,
          appGids: connection.appGids,
        })
        ok = result.ok
        inserted = result.inserted
        appsFound = result.appsSeen
        error = result.error ?? null
        earningsError = result.earningsError ?? null
        legacyError = result.legacyError ?? null
      } catch (err) {
        error = describeError(err)
      }

      // Derived tables are rebuilt even after a failed run: events stored before the
      // failure are real and should show up.
      try {
        await rebuildStaleApps(db)
      } catch (err) {
        ok = false
        error = error ?? `Rebuild failed: ${describeError(err)}`
      }

      const finishedAt = new Date()
      await db
        .update(connections)
        .set({ lastOkAt: ok ? finishedAt : undefined, lastError: error, earningsError, legacyError })
        .where(eq(connections.id, connection.id))
      await db
        .update(syncRuns)
        .set({ finishedAt, ok, eventsInserted: inserted, appsFound, error, durationMs: finishedAt.getTime() - startedAt.getTime() })
        .where(eq(syncRuns.id, run.id))

      log[ok ? "info" : "warn"]("sync finished", { connection: connection.label, trigger, ok, inserted, appsFound, error, earningsError, legacyError })
    } finally {
      await held`select pg_advisory_unlock(hashtext(${"appmetrics-sync-" + connection.id}))`.catch(() => {})
    }
  } finally {
    held.release()
  }
}

async function tick(database: Database, env: Env): Promise<void> {
  const { db } = database
  const intervalMs = env.syncIntervalMinutes * 60_000

  if (!env.demoMode) {
    const rows = await db.select().from(connections).where(and(eq(connections.paused, false), eq(connections.isDemo, false)))
    for (const connection of rows) {
      if (stopping) return
      const requested = connection.syncRequestedAt !== null
      const never = connection.lastRunAt === null
      const due = never || Date.now() - connection.lastRunAt!.getTime() >= intervalMs
      if (requested || due) await syncOne(database, connection, requested ? "manual" : never ? "startup" : "schedule")
    }
  }

  // Rows for today, and anything that gained events since the last build.
  await rebuildStaleApps(db)
}

async function housekeeping(database: Database): Promise<void> {
  await purgeExpiredSessions(database.db)
  await purgeOldApiCalls(database.db)
  await database.db.delete(syncRuns).where(lt(syncRuns.startedAt, sql`now() - make_interval(days => ${KEEP_RUNS_DAYS})`))
}

async function main(): Promise<void> {
  const env = getEnv()
  const database = createDatabase(env.databaseUrl, { max: 5 })
  await runMigrations(database)
  log.info("worker started", { syncIntervalMinutes: env.syncIntervalMinutes, demoMode: env.demoMode })

  const stop = () => {
    stopping = true
    wake?.()
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)

  let lastHousekeeping = 0
  while (!stopping) {
    try {
      await tick(database, env)
      if (Date.now() - lastHousekeeping > HOUSEKEEPING_MS) {
        await housekeeping(database)
        lastHousekeeping = Date.now()
      }
    } catch (err) {
      log.error("worker tick failed", { error: describeError(err) })
    }
    if (!stopping) await sleep(POLL_MS)
  }

  log.info("worker stopping")
  await database.close()
}

main().catch((err) => {
  log.error("worker crashed", { error: describeError(err) })
  process.exit(1)
})
