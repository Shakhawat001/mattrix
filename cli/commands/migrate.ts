import { createDatabase } from "@/lib/db/client"
import { runMigrations } from "@/lib/db/migrate"

/** Needs only DATABASE_URL, so it can run before the rest of the configuration is in place. */
export async function migrateCommand(): Promise<number> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error("DATABASE_URL is not set.")
    return 1
  }
  const database = createDatabase(url, { max: 2 })
  try {
    await runMigrations(database)
    console.log("Database is up to date.")
    return 0
  } finally {
    await database.close()
  }
}
