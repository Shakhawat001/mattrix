import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { getAnnotations, listAnnotations } from "@/lib/analytics/annotations"
import type { Database, Queryable } from "@/lib/db/client"
import { annotations, apps, connections } from "@/lib/db/schema"
import { clearAll, hasDatabase, openTestDatabase } from "../helpers/db"

describe.skipIf(!hasDatabase)("annotations (Postgres)", () => {
  let database: Database
  let connectionId: string
  let a: string
  let b: string
  let c: string

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(() => database.close())

  beforeEach(async () => {
    await clearAll(database)
    const [conn] = await database.db
      .insert(connections)
      .values({ label: "Test org", partnerId: "42", tokenCiphertext: "x", tokenHint: "abcd", backfillFrom: new Date("2025-01-01") })
      .returning({ id: connections.id })
    connectionId = conn.id
    const addApp = async (n: number, name: string) => {
      const [row] = await database.db.insert(apps).values({ connectionId, gid: `gid://shopify/App/${n}`, name }).returning({ id: apps.id })
      return row.id
    }
    a = await addApp(1, "A")
    b = await addApp(2, "B")
    c = await addApp(3, "C")
  })

  /** Adds annotations; each one is created a minute after the one before, so ties on a day have a known order. */
  async function mark(list: { appId: string | null; date: string; label: string; note?: string }[]) {
    await database.db.insert(annotations).values(list.map((x, i) => ({ ...x, createdAt: new Date(Date.UTC(2026, 0, 1, 12, i)) })))
  }
  const labels = (rows: { label: string }[]) => rows.map((r) => r.label)
  /** A read inside a read-only transaction, the way the MCP server runs every tool. */
  const readOnly = <T>(read: (q: Queryable) => Promise<T>): Promise<T> => database.db.transaction((tx) => read(tx), { accessMode: "read only" })

  it("reads each chosen app's own annotations and the every-app ones, oldest first", async () => {
    await mark([
      { appId: a, date: "2026-03-05", label: "A release" },
      { appId: null, date: "2026-03-01", label: "Price change", note: "Every plan up by $5" },
      { appId: b, date: "2026-03-03", label: "B featured" },
      { appId: c, date: "2026-03-04", label: "C ad campaign" },
    ])
    const march = { from: "2026-03-01", to: "2026-03-31" }

    const both = await getAnnotations(database.db, [a, b], march)
    expect(labels(both)).toEqual(["Price change", "B featured", "A release"])
    expect(both[0]).toEqual({ id: expect.any(String), appId: null, date: "2026-03-01", label: "Price change", note: "Every plan up by $5", createdAt: new Date(Date.UTC(2026, 0, 1, 12, 1)) })
    expect(both[1]).toMatchObject({ appId: b, date: "2026-03-03", note: null })

    // Another app's annotations are left out; the every-app ones belong to every app.
    expect(labels(await getAnnotations(database.db, [a], march))).toEqual(["Price change", "A release"])
    expect(labels(await getAnnotations(database.db, [c], march))).toEqual(["Price change", "C ad campaign"])
  })

  it("includes both ends of the range and nothing outside it", async () => {
    await mark([
      { appId: a, date: "2026-02-28", label: "Day before" },
      { appId: a, date: "2026-03-01", label: "First day" },
      { appId: null, date: "2026-03-15", label: "Middle" },
      { appId: null, date: "2026-03-31", label: "Last day" },
      { appId: a, date: "2026-04-01", label: "Day after" },
    ])
    expect(labels(await getAnnotations(database.db, [a], { from: "2026-03-01", to: "2026-03-31" }))).toEqual(["First day", "Middle", "Last day"])
    expect(labels(await getAnnotations(database.db, [a], { from: "2026-03-31", to: "2026-03-31" }))).toEqual(["Last day"])
    expect(await getAnnotations(database.db, [a], { from: "2026-03-02", to: "2026-03-14" })).toEqual([])
  })

  it("orders a day's annotations by when they were added", async () => {
    await mark([
      { appId: a, date: "2026-03-10", label: "First added" },
      { appId: null, date: "2026-03-10", label: "Second added" },
      { appId: b, date: "2026-03-09", label: "A day earlier" },
    ])
    expect(labels(await getAnnotations(database.db, [a, b], { from: "2026-03-01", to: "2026-03-31" }))).toEqual(["A day earlier", "First added", "Second added"])
  })

  it("reads nothing for no apps, even with every-app annotations", async () => {
    await mark([{ appId: null, date: "2026-03-01", label: "Price change" }])
    expect(await getAnnotations(database.db, [], { from: "2026-01-01", to: "2026-12-31" })).toEqual([])
  })

  it("lists every annotation for Settings, newest first", async () => {
    await mark([
      { appId: a, date: "2026-03-05", label: "A release" },
      { appId: null, date: "2026-03-01", label: "Price change" },
      { appId: c, date: "2027-01-15", label: "Planned launch" },
      { appId: b, date: "2026-03-05", label: "B featured, added later" },
    ])
    expect(labels(await listAnnotations(database.db))).toEqual(["Planned launch", "B featured, added later", "A release", "Price change"])
  })

  it("deletes an app's annotations with the app, and keeps the every-app ones", async () => {
    await mark([
      { appId: a, date: "2026-03-05", label: "A release" },
      { appId: b, date: "2026-03-03", label: "B featured" },
      { appId: null, date: "2026-03-01", label: "Price change" },
    ])

    await database.db.delete(apps).where(eq(apps.id, a))
    expect(labels(await listAnnotations(database.db))).toEqual(["B featured", "Price change"])

    // Removing a connection removes its apps, and so their annotations.
    await database.db.delete(connections).where(eq(connections.id, connectionId))
    expect(labels(await listAnnotations(database.db))).toEqual(["Price change"])
  })

  it("reads the same inside a read-only transaction", async () => {
    await mark([
      { appId: a, date: "2026-03-05", label: "A release" },
      { appId: null, date: "2026-03-01", label: "Price change" },
    ])
    const march = { from: "2026-03-01", to: "2026-03-31" }
    const inside = await readOnly((tx) => getAnnotations(tx, [a], march))
    expect(labels(inside)).toEqual(["Price change", "A release"])
    expect(inside).toEqual(await getAnnotations(database.db, [a], march))
    expect(await readOnly((tx) => listAnnotations(tx))).toEqual(await listAnnotations(database.db))
  })

  it("refuses an annotation for an app that does not exist", async () => {
    // The action relies on this error to answer a form sent just after its app was removed.
    await expect(database.db.insert(annotations).values({ appId: randomUUID(), date: "2026-03-01", label: "Gone" })).rejects.toMatchObject({ cause: { code: "23503" } })
  })
})
