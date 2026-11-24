import { and, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { listApps, type AppInfo } from "@/lib/analytics/queries"
import type { ApiCaller } from "@/lib/auth/api-tokens"
import type { Db, Queryable } from "@/lib/db/client"
import { events } from "@/lib/db/schema"
import { isShopAlias, resolveShopAlias, shopAlias } from "./output"
import { ToolError } from "./tool"

// What a tool call gets: who is asking, a runner for read-only queries, and the apps the caller may
// see. lib/mcp/http.ts builds one per request, after the token has been checked.

export const STATEMENT_TIMEOUT = "15s"

export type McpContext = {
  /** The token making the request: its id, name and settings, never the token itself. */
  token: ApiCaller
  /** Shop domains are replaced by aliases in every answer, and a shop given as input must be an alias. */
  hideShops: boolean
  /** When the request arrived. A tool takes "today" from this. */
  now: Date
  /** Runs fn in a read-only transaction whose statements stop after 15 seconds. Every database read a tool makes goes through here. */
  read<T>(fn: (db: Queryable) => Promise<T>): Promise<T>
  /** The apps the caller may read: those not hidden, as on the dashboard. Given ids, exactly those apps, or a ToolError naming any that are not among them. */
  apps(ids?: readonly string[]): Promise<AppInfo[]>
  /** The domain of a shop given as input: its alias for a token that hides domains, otherwise the domain. Null when no shop of these apps matches. */
  resolveShop(input: string, appIds: readonly string[]): Promise<string | null>
  /** The alias a token that hides domains sees for a shop. */
  aliasOf(domain: string): string
}

/** Runs fn in a READ ONLY transaction with a 15 second statement timeout. A write inside it fails, and so does a statement that runs too long. */
export function readOnly<T>(db: Db, fn: (db: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`))
      return fn(tx)
    },
    { accessMode: "read only" }
  )
}

export function createContext(options: { db: Db; secret: string; token: ApiCaller; now?: Date }): McpContext {
  const { db, secret, token } = options
  const read = <T>(fn: (db: Queryable) => Promise<T>) => readOnly(db, fn)
  const aliasOf = (domain: string) => shopAlias(secret, domain)
  let visible: Promise<AppInfo[]> | undefined

  return {
    token,
    hideShops: token.hideShops,
    now: options.now ?? new Date(),
    read,
    aliasOf,

    async apps(ids) {
      visible ??= read((q) => listApps(q)).then((all) => all.filter((a) => !a.hidden))
      const apps = await visible
      if (ids === undefined) return apps
      const unknown = ids.filter((id) => !apps.some((a) => a.id === id))
      if (unknown.length > 0) throw new ToolError(`Unknown app id: ${unknown.join(", ")}. list_apps gives the ids.`)
      return apps.filter((a) => ids.includes(a.id))
    },

    async resolveShop(input, appIds) {
      const value = input.trim().toLowerCase()
      if (appIds.length === 0 || value === "") return null
      if (!token.hideShops) {
        const [row] = await read((q) => q.select({ shop: events.shop }).from(events).where(and(inArray(events.appId, [...appIds]), eq(events.shop, value))).limit(1))
        return row?.shop ?? null
      }
      if (!isShopAlias(value)) throw new ToolError("This token hides shop domains. Give the shop's alias, such as shop_3f9a1c2b7e, as other answers show it.")
      const rows = await read((q) => q.selectDistinct({ shop: events.shop }).from(events).where(and(inArray(events.appId, [...appIds]), isNotNull(events.shop))))
      const matches = resolveShopAlias(value, rows.map((r) => r.shop as string), aliasOf)
      if (matches.length > 1) throw new ToolError(`${value} stands for more than one shop of these apps, so it cannot pick one out. Try with fewer apps.`)
      return matches[0] ?? null
    },
  }
}
