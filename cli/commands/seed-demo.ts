import { eq } from "drizzle-orm"
import { rebuildStaleApps } from "@/lib/analytics/rebuild"
import { createDatabase } from "@/lib/db/client"
import { runMigrations } from "@/lib/db/migrate"
import { connections } from "@/lib/db/schema"
import { generateDemoEvents } from "@/lib/demo/generate"
import { getEnv } from "@/lib/env"
import { insertEvents } from "@/lib/partner/store"
import { encryptToken } from "@/lib/secrets"

/**
 * Replaces any demo connection with a fresh year of invented history for three
 * invented apps. Your real connections are not touched. Set DEMO_MODE=true if the
 * worker should also stay away from Shopify while you look around.
 */
export async function seedDemoCommand(): Promise<number> {
  const env = getEnv()
  const database = createDatabase(env.databaseUrl, { max: 4 })
  try {
    await runMigrations(database)
    const { db } = database
    await db.delete(connections).where(eq(connections.isDemo, true))

    const now = new Date()
    const { ciphertext, hint } = encryptToken("demo-token")
    const [connection] = await db
      .insert(connections)
      .values({
        label: "Demo organization",
        partnerId: "0",
        tokenCiphertext: ciphertext,
        tokenHint: hint,
        backfillFrom: new Date(now.getTime() - 400 * 86_400_000),
        isDemo: true,
        paused: true,
        lastOkAt: now,
        lastRunAt: now,
      })
      .returning({ id: connections.id })

    const { events, apps } = generateDemoEvents({ now })
    const { inserted } = await insertEvents(db, connection.id, events)
    await rebuildStaleApps(db, now)
    console.log(`Seeded ${apps.length} demo apps with ${inserted} events: ${apps.map((a) => a.name).join(", ")}.`)
    return 0
  } finally {
    await database.close()
  }
}
