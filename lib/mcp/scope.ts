import { asc, inArray } from "drizzle-orm"
import { z } from "zod"
import { earliestDate, type AppInfo } from "@/lib/analytics/queries"
import { connections } from "@/lib/db/schema"
import { todayIn } from "@/lib/time-zone"
import type { McpContext } from "./context"
import { toolRange, type RangeInput, type ToolRange } from "./range"
import { earningsNotes } from "./tools/list-apps"

// The apps a tool reads and, for a tool with a range, the range: read and checked the same way in
// every tool, with the caveats that come with them. A tool spreads APPS_INPUT into its schema next to
// RANGE_INPUT, calls readScope(ctx, input), and passes the scope's range, compared range and notes to
// envelope().

export const APPS_INPUT = {
  app_ids: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(100)
    .optional()
    .describe("The apps to read, by the ids list_apps gives. Default: every app that is not hidden, together."),
}

export type Scope = ToolRange & {
  apps: AppInfo[]
  appIds: string[]
  /** The dashboard's time zone: the range's days are days there. */
  timeZone: string
}

/** The apps asked for (every visible one by default) and the range, with notes on both. Throws a ToolError for an unknown app or a range it cannot read. */
export async function readScope(ctx: McpContext, input: RangeInput & { app_ids?: string[] }, options: { earnings?: boolean } = {}): Promise<Scope> {
  const apps = await ctx.apps(input.app_ids)
  const appIds = apps.map((a) => a.id)
  const [earliest, sources, timeZone] = await Promise.all([ctx.read((db) => earliestDate(db, appIds)), sourceNotes(ctx, apps, options), ctx.timeZone()])
  const asked = toolRange(input, todayIn(timeZone, ctx.now), earliest)

  const notes = [...asked.notes, ...sources]
  if (earliest === null) notes.push(apps.length === 0 ? "No app is visible, so there is nothing to count. list_apps says what is connected." : "These apps have no data yet.")
  else {
    if (asked.range.from < earliest) notes.push(`The data of these apps starts on ${earliest}. Nothing before that day was read, so the part of the range before it is empty.`)
    if (asked.compared && asked.compared.from < earliest) notes.push(`The compared range starts before the data of these apps does, on ${earliest}, so the previous values leave out what happened before that day.`)
  }
  return { ...asked, notes, apps, appIds, timeZone }
}

/** What a tool says about the apps it read. */
export const appList = (apps: AppInfo[]) => apps.map((a) => ({ id: a.id, name: a.label }))

/**
 * Caveats about where the apps' numbers come from: demo data, a connection that has not finished a
 * sync or whose last sync failed, and, for a tool that shows earnings, a token that cannot read them.
 */
export async function sourceNotes(ctx: McpContext, apps: AppInfo[], options: { earnings?: boolean } = {}): Promise<string[]> {
  const ids = [...new Set(apps.map((a) => a.connectionId))]
  if (ids.length === 0) return []
  const rows = await ctx.read((db) =>
    db
      .select({
        label: connections.label,
        isDemo: connections.isDemo,
        lastOkAt: connections.lastOkAt,
        lastError: connections.lastError,
        earningsError: connections.earningsError,
        transactionsError: connections.transactionsError,
      })
      .from(connections)
      .where(inArray(connections.id, ids))
      .orderBy(asc(connections.createdAt), asc(connections.id))
  )
  const notes: string[] = []
  for (const c of rows) {
    if (c.isDemo) notes.push(`${c.label} holds demo data made up by the seed-demo command. None of it is real.`)
    else if (c.lastOkAt === null) notes.push(`${c.label} has not finished a sync yet, so its apps may have no numbers.`)
    if (c.lastError !== null) notes.push(`The last sync of ${c.label} failed, so its apps' numbers may be out of date. list_apps says why.`)
    if (options.earnings) notes.push(...earningsNotes(c, "list_apps says why."))
  }
  return notes
}
