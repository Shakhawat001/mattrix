import { sql, type SQL } from "drizzle-orm"
import type { Db } from "@/lib/db/client"
import { parseTimestamp } from "@/lib/db/timestamps"
import { toMs, type Range } from "./range"

// Win-back: the shops that uninstalled in a range, and which of them installed the app again.
// The group is the shops that left during the range; whether they came back is followed up to
// today, the way the cohort tables follow theirs. A shop counts once, from the first time it
// left in the range, however often it left. Like the uninstall reasons, this reads the stays,
// so an uninstall whose install was never seen (before the history starts) is not in the group.

const DAY_MS = 86_400_000

/** `('a', 'b')` for a raw query. An empty list matches nothing. */
const inList = (ids: string[]): SQL => (ids.length === 0 ? sql`(NULL)` : sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
const startOf = (date: string) => new Date(`${date}T00:00:00Z`)
/** The first instant after a day. */
const endOf = (date: string) => new Date(toMs(date) + DAY_MS)
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`

export type WinBackReturn = { appId: string; shop: string; leftAt: Date; backAt: Date; days: number }

export type WinBack = {
  /** Shops that uninstalled in the range. */
  left: number
  /** Of them, the shops that installed the app again afterwards. */
  returned: number
  /** `returned` over `left`; null when no shop left. */
  rate: number | null
  /** Median days from leaving to coming back, among the shops that returned. */
  medianDays: number | null
  /** The latest returns, newest first. */
  recent: WinBackReturn[]
}

export const noWinBack = (): WinBack => ({ left: 0, returned: 0, rate: null, medianDays: null, recent: [] })

export async function getWinBack(db: Db, appIds: string[], range: Range, limit = 10): Promise<WinBack> {
  if (appIds.length === 0) return noWinBack()

  // One row per shop that left in the range: when it first left, and its next install after that.
  const returns = sql`
    WITH left_shops AS (
      SELECT app_id, shop, min(uninstalled_at) AS left_at
      FROM installs
      WHERE app_id IN ${inList(appIds)} AND uninstalled_at >= ${ts(startOf(range.from))} AND uninstalled_at < ${ts(endOf(range.to))}
      GROUP BY app_id, shop
    )
    SELECT l.app_id, l.shop, l.left_at,
           (SELECT min(i.installed_at) FROM installs i WHERE i.app_id = l.app_id AND i.shop = l.shop AND i.installed_at > l.left_at) AS back_at
    FROM left_shops l
  `

  const [[stats], rows] = await Promise.all([
    db.execute<{ left_n: number; back_n: number; median: number | string | null }>(sql`
      SELECT count(*)::int AS left_n,
             count(back_at)::int AS back_n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (back_at - left_at)) / 86400) FILTER (WHERE back_at IS NOT NULL) AS median
      FROM (${returns}) r
    `),
    // Raw SQL hands timestamps back as text, so they are read into Dates below.
    db.execute<{ app_id: string; shop: string; left_at: string | Date; back_at: string | Date }>(sql`
      SELECT app_id, shop, left_at, back_at
      FROM (${returns}) r
      WHERE back_at IS NOT NULL
      ORDER BY back_at DESC, shop, app_id
      LIMIT ${limit}
    `),
  ])

  return {
    left: stats.left_n,
    returned: stats.back_n,
    rate: stats.left_n > 0 ? stats.back_n / stats.left_n : null,
    medianDays: stats.median === null ? null : Number(stats.median),
    recent: rows.map((r) => {
      const leftAt = parseTimestamp(r.left_at)
      const backAt = parseTimestamp(r.back_at)
      return { appId: r.app_id, shop: r.shop, leftAt, backAt, days: (backAt.getTime() - leftAt.getTime()) / DAY_MS }
    }),
  }
}
