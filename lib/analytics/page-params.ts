import type { Db } from "@/lib/db/client"
import { todayIn } from "@/lib/time-zone"
import { earliestDate, type AppInfo } from "./queries"
import {
  autoGranularity,
  compareRange,
  resolveRange,
  type Compare,
  type Granularity,
  type Range,
} from "./range"

// What every page needs from the URL, validated: the range, the comparison, the bucket
// size and the apps. The URL is the state, so any view can be bookmarked or shared. The
// time zone is not in the URL: it is a setting, so the same link shows the same days.

export type SearchParams = Record<string, string | string[] | undefined>

export type PageParams = {
  range: Range
  compare: Compare
  compared: Range | null
  granularity: Granularity
  granularitySetting: Granularity | "auto"
  appIds: string[]
  earliest: string | null
  /** Today in the dashboard's time zone. */
  today: string
  /** The dashboard's time zone, which the range's days are days in. */
  timeZone: string
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export async function loadPageParams(
  db: Db,
  params: SearchParams,
  /** The apps this page may show. */
  scope: AppInfo[],
  timeZone: string,
  now: Date = new Date(),
): Promise<PageParams> {
  const today = todayIn(timeZone, now)
  const scopeIds = scope.map((a) => a.id)
  const earliest = await earliestDate(db, scopeIds)

  const range = resolveRange({ from: first(params.from), to: first(params.to), preset: first(params.preset) }, today, earliest)
  const compareParam = first(params.compare)
  const compare: Compare = compareParam === "previous" || compareParam === "year" ? compareParam : "none"
  const granParam = first(params.gran)
  const granularitySetting = granParam === "day" || granParam === "week" || granParam === "month" ? granParam : "auto"

  const asked = (first(params.apps) ?? "").split(",").filter(Boolean)
  const chosen = asked.filter((id) => scopeIds.includes(id))

  return {
    range,
    compare,
    compared: compareRange(range, compare),
    granularity: granularitySetting === "auto" ? autoGranularity(range) : granularitySetting,
    granularitySetting,
    appIds: chosen.length > 0 ? chosen : scopeIds,
    earliest,
    today,
    timeZone,
  }
}
