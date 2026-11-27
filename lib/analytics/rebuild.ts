import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm"
import type { Db } from "@/lib/db/client"
import { apps, connections, dailyMetrics, events, excludedShops, installs, subscriptions, trials } from "@/lib/db/schema"
import { startOfDay, todayIn } from "@/lib/time-zone"
import { DERIVE_VERSION, derive } from "./derive"
import { readTimeZone } from "./queries"

const CHUNK = 1000

async function insertChunked<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await write(rows.slice(i, i + CHUNK))
}

/**
 * Rebuilds one app's derived tables from its events, leaving out the excluded shops, with days
 * counted in `timeZone`. Replaces them in one transaction, and records the zone in the same one,
 * so a page never sees half of a rebuild or a rollup labeled with a zone it was not built in.
 * Cheap enough to run in full every time: it reads the events once and writes a few rows per shop
 * and per day.
 *
 * The app's row stays locked from before the events are read until the new rows are in. Whatever
 * marks the app dirty meanwhile (a sync storing events, a change to the excluded shops) waits for
 * the lock and marks it again afterwards, so it is rebuilt once more instead of being cleared unseen.
 */
export async function rebuildApp(db: Db, appId: string, timeZone: string, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const [app] = await tx.select({ id: apps.id, connectionId: apps.connectionId }).from(apps).where(eq(apps.id, appId)).for("no key update")
    if (!app) return
    // How far the sync has read the payout ledger: earnings come from it up to then (derive()).
    const [source] = await tx.select({ ledgerReadUntil: connections.transactionsWatermark }).from(connections).where(eq(connections.id, app.connectionId))

    const raw = await tx
      .select({
        type: events.type,
        occurredAt: events.occurredAt,
        shop: events.shop,
        reason: events.reason,
        reasonDescription: events.reasonDescription,
        planHandle: events.planHandle,
        billingPeriod: events.billingPeriod,
        trialDays: events.trialDays,
        trialDaysRemaining: events.trialDaysRemaining,
        cancelEffectiveOn: events.cancelEffectiveOn,
        amountCents: events.amountCents,
        grossCents: events.grossCents,
        netCents: events.netCents,
        feeCents: events.feeCents,
      })
      .from(events)
      .where(and(eq(events.appId, appId), sql`NOT EXISTS (SELECT 1 FROM ${excludedShops} WHERE ${excludedShops.shop} = lower(${events.shop}))`))
      // Then by id, so events at the same instant reach derive() in the same order on every rebuild.
      .orderBy(asc(events.occurredAt), asc(events.id))

    const result = derive(raw, now, timeZone, source?.ledgerReadUntil ?? null)

    await tx.delete(installs).where(eq(installs.appId, appId))
    await tx.delete(subscriptions).where(eq(subscriptions.appId, appId))
    await tx.delete(trials).where(eq(trials.appId, appId))
    await tx.delete(dailyMetrics).where(eq(dailyMetrics.appId, appId))

    await insertChunked(result.installs, (chunk) => tx.insert(installs).values(chunk.map((r) => ({ ...r, appId }))))
    await insertChunked(result.subscriptions, (chunk) => tx.insert(subscriptions).values(chunk.map((r) => ({ ...r, appId }))))
    await insertChunked(result.trials, (chunk) => tx.insert(trials).values(chunk.map((r) => ({ ...r, appId }))))
    await insertChunked(result.daily, (chunk) => tx.insert(dailyMetrics).values(chunk.map((r) => ({ ...r, appId }))))

    await tx
      .update(apps)
      .set({ dirty: false, derivedAt: now, deriveVersion: DERIVE_VERSION, derivedTimeZone: timeZone, ledgerUntil: result.ledgerUntil })
      .where(eq(apps.id, appId))
  })
}

/**
 * Rebuilds the apps that gained events, the ones not built since the start of today (so
 * every chart has a row for today even on a quiet day), the ones built with an older version
 * of the rules, and the ones built in another time zone than the one Settings names now. The
 * zone is read once, so every app in one pass is built in the same one; if it changes
 * meanwhile, the next pass catches up.
 */
export async function rebuildStaleApps(db: Db, now: Date = new Date()): Promise<number> {
  const timeZone = await readTimeZone(db)
  const startOfToday = startOfDay(todayIn(timeZone, now), timeZone)
  const stale = await db
    .select({ id: apps.id })
    .from(apps)
    .where(
      or(
        eq(apps.dirty, true),
        isNull(apps.derivedAt),
        lt(apps.derivedAt, startOfToday),
        lt(apps.deriveVersion, DERIVE_VERSION),
        sql`${apps.derivedTimeZone} IS DISTINCT FROM ${timeZone}`,
      ),
    )
  for (const app of stale) await rebuildApp(db, app.id, timeZone, now)
  return stale.length
}
