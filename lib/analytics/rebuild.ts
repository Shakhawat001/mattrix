import { asc, eq, isNull, lt, or } from "drizzle-orm"
import type { Db } from "@/lib/db/client"
import { apps, dailyMetrics, events, installs, subscriptions, trials } from "@/lib/db/schema"
import { derive } from "./derive"

const CHUNK = 1000

async function insertChunked<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await write(rows.slice(i, i + CHUNK))
}

/**
 * Rebuilds one app's derived tables from its events. Replaces them in one
 * transaction, so a page never sees half of a rebuild. Cheap enough to run in full
 * every time: it reads the events once and writes a few rows per shop and per day.
 */
export async function rebuildApp(db: Db, appId: string, now: Date = new Date()): Promise<void> {
  const raw = await db
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
    .where(eq(events.appId, appId))
    .orderBy(asc(events.occurredAt))

  const result = derive(raw, now)

  await db.transaction(async (tx) => {
    await tx.delete(installs).where(eq(installs.appId, appId))
    await tx.delete(subscriptions).where(eq(subscriptions.appId, appId))
    await tx.delete(trials).where(eq(trials.appId, appId))
    await tx.delete(dailyMetrics).where(eq(dailyMetrics.appId, appId))

    await insertChunked(result.installs, (chunk) => tx.insert(installs).values(chunk.map((r) => ({ ...r, appId }))))
    await insertChunked(result.subscriptions, (chunk) => tx.insert(subscriptions).values(chunk.map((r) => ({ ...r, appId }))))
    await insertChunked(result.trials, (chunk) => tx.insert(trials).values(chunk.map((r) => ({ ...r, appId }))))
    await insertChunked(result.daily, (chunk) => tx.insert(dailyMetrics).values(chunk.map((r) => ({ ...r, appId }))))

    await tx.update(apps).set({ dirty: false, derivedAt: now }).where(eq(apps.id, appId))
  })
}

/**
 * Rebuilds the apps that gained events, and the ones not built since the start of
 * today, so every chart has a row for today even on a quiet day.
 */
export async function rebuildStaleApps(db: Db, now: Date = new Date()): Promise<number> {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const stale = await db
    .select({ id: apps.id })
    .from(apps)
    .where(or(eq(apps.dirty, true), isNull(apps.derivedAt), lt(apps.derivedAt, startOfToday)))
  for (const app of stale) await rebuildApp(db, app.id, now)
  return stale.length
}
