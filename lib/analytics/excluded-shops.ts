import { asc, eq } from "drizzle-orm"
import type { Db } from "@/lib/db/client"
import { apps, excludedShops } from "@/lib/db/schema"

// Shops left out of every number: your own development stores, test installs, Shopify's review
// stores. Their events stay stored, and rebuildApp() builds without them, so a change to the list
// marks every app for a rebuild. The worker runs it within a minute.

const SUFFIX = ".myshopify.com"
/** A store's handle: the part before .myshopify.com. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * A shop the way events store it: its myshopify.com domain in lower case. Takes what is easy to
 * paste: the domain, an address with a path, an admin.shopify.com/store/... address, or the
 * store's handle alone. Null for anything else, a custom domain included, since events never
 * name a shop by one.
 */
export function normalizeShop(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  const [host, ...path] = text.split(/[/?#]/)
  const handle =
    host === "admin.shopify.com" ? (path[0] === "store" ? path[1] : undefined)
    : host.endsWith(SUFFIX) ? host.slice(0, -SUFFIX.length)
    : host.includes(".") ? undefined
    : host
  return handle && HANDLE.test(handle) ? `${handle}${SUFFIX}` : null
}

export type ExcludedShop = { shop: string; note: string | null; createdAt: Date }

export async function listExcludedShops(db: Db): Promise<ExcludedShop[]> {
  return db
    .select({ shop: excludedShops.shop, note: excludedShops.note, createdAt: excludedShops.createdAt })
    .from(excludedShops)
    .orderBy(asc(excludedShops.shop))
}

/** Adds a shop, given as normalizeShop() returns it, and marks every app for a rebuild. False when it was already on the list. */
export async function addExcludedShop(db: Db, shop: string, note: string | null): Promise<boolean> {
  return db.transaction(async (tx) => {
    const added = await tx.insert(excludedShops).values({ shop, note }).onConflictDoNothing().returning({ shop: excludedShops.shop })
    if (added.length === 0) return false
    await tx.update(apps).set({ dirty: true })
    return true
  })
}

/** Takes a shop off the list and marks every app for a rebuild. False when it was not on it. */
export async function removeExcludedShop(db: Db, shop: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx.delete(excludedShops).where(eq(excludedShops.shop, shop)).returning({ shop: excludedShops.shop })
    if (removed.length === 0) return false
    await tx.update(apps).set({ dirty: true })
    return true
  })
}
