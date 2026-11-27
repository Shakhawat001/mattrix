import { z } from "zod"
import { listShops, type ShopFilters, type ShopRow } from "@/lib/analytics/queries"
import { billing, count, envelope, instant, money, reasonLabels } from "../output"
import { APPS_INPUT, appList, sourceNotes } from "../scope"
import { defineTool, ToolError } from "../tool"

const DEFAULT_PAGE_SIZE = 25
const MOST_PER_PAGE = 100

/** What a shop is on now, as the shops page words it. */
function planOf(s: ShopRow) {
  if (s.subscribed || s.inTrial) return { status: s.subscribed ? "paying" : "trial", plan: s.planHandle, billing_period: billing(s.billingPeriod), monthly_price: money(s.monthlyCents) }
  return { status: s.installed ? "free" : "none" }
}

const row = (s: ShopRow) => ({
  app_id: s.appId,
  shop: s.shop,
  installed: s.installed,
  installs: count(s.installs),
  first_installed_at: instant(s.firstInstalledAt),
  last_installed_at: instant(s.lastInstalledAt),
  uninstalled_at: instant(s.uninstalledAt),
  uninstall_reasons: reasonLabels(s.reason),
  plan: planOf(s),
  mrr: money(s.subscribed ? s.monthlyCents : 0),
  charged: money(s.charged),
})

export const listShopsTool = defineTool({
  name: "list_shops",
  title: "List shops",
  description: [
    "Every shop that has installed the chosen apps (default: every app that is not hidden), one row per shop per app, as the dashboard's shops page lists them: installed or not, how many times it installed, when it first and last installed and when it left, the reasons it gave, what it is on now (paying, trial, free or none, with the plan and its monthly price), the MRR it adds now and all it has been charged.",
    `Filter by status and plan, sort, and page through the results, ${DEFAULT_PAGE_SIZE} a page unless you ask for up to ${MOST_PER_PAGE}. Not limited by a date range.`,
    "search finds part of a domain; shop picks one shop by its domain, or by its alias for a token that hides domains. Such a token cannot search domains or sort by them.",
  ].join(" "),
  input: z.object({
    ...APPS_INPUT,
    status: z.enum(["installed", "uninstalled"]).optional().describe("installed (has the app now) or uninstalled. Default: both."),
    plan: z.enum(["paying", "trial", "free", "churned"]).optional().describe("paying (pays for a plan now), trial (in a free trial of a paid plan), free (installed, pays nothing) or churned (paid before, not now). Default: any."),
    sort: z.enum(["recent", "mrr", "revenue", "shop"]).optional().describe("recent (latest install first), mrr (highest MRR first), revenue (most charged first) or shop (by domain). Default: recent."),
    search: z.string().min(1).max(100).optional().describe("Part of a shop's domain, as the dashboard's search box takes it. Not for a token that hides shop domains."),
    shop: z.string().min(1).max(255).optional().describe("One shop: its myshopify.com domain, or its alias (shop_ and 10 hex characters) for a token that hides shop domains."),
    page: z.number().int().min(1).optional().describe("The page, from 1. Default: 1."),
    page_size: z.number().int().min(1).max(MOST_PER_PAGE).optional().describe(`Shops per page. Default: ${DEFAULT_PAGE_SIZE}.`),
  }),
  async run(ctx, input) {
    if (ctx.hideShops && input.search !== undefined) throw new ToolError("This token hides shop domains, so it cannot search them. Give a shop's alias as shop instead.")
    if (ctx.hideShops && input.sort === "shop") throw new ToolError("This token hides shop domains, so it cannot sort by them. Sort by recent, mrr or revenue.")

    const apps = await ctx.apps(input.app_ids)
    const appIds = apps.map((a) => a.id)
    const page = input.page ?? 1
    const pageSize = input.page_size ?? DEFAULT_PAGE_SIZE
    const [notes, timeZone] = await Promise.all([sourceNotes(ctx, apps), ctx.timeZone()])
    const answer = (rows: ShopRow[], total: number) => {
      const pages = Math.ceil(total / pageSize)
      return envelope(
        { apps: appList(apps), page, page_size: pageSize, pages, next_page: page < pages ? page + 1 : null, total: count(total), rows: rows.map(row) },
        { timeZone, notes }
      )
    }

    const filters: ShopFilters = { q: input.search, status: input.status, plan: input.plan, sort: input.sort, page, pageSize }
    if (input.shop !== undefined) {
      const shop = await ctx.resolveShop(input.shop, appIds)
      if (shop === null) {
        notes.push(`No shop of these apps matches ${input.shop.trim().toLowerCase()}.`)
        return answer([], 0)
      }
      filters.shop = shop
    }

    const { rows, total } = await ctx.read(async (db) => {
      const found = await listShops(db, appIds, filters)
      // Past the last page there is no row to carry the total, so it is counted on the first.
      if (found.rows.length > 0 || page === 1) return found
      return { rows: found.rows, total: (await listShops(db, appIds, { ...filters, page: 1, pageSize: 1 })).total }
    })
    if (rows.length === 0 && total > 0) notes.push(`Page ${page} is past the last page, ${Math.ceil(total / pageSize)}.`)
    return answer(rows, total)
  },
})
