import path from "node:path"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Database } from "./client"

const LOCK_ID = 7_345_001

/**
 * Applies pending migrations. The web server and the worker both call this when
 * they start, so a lock makes whichever gets there second wait and then find
 * nothing to do. The lock lives on a reserved connection, because a session lock
 * belongs to the connection that took it.
 */
export async function runMigrations(
  database: Database,
  folder: string = path.resolve(process.cwd(), "drizzle"),
): Promise<void> {
  const held = await database.sql.reserve()
  try {
    await held`select pg_advisory_lock(${LOCK_ID})`
    await migrate(database.db, { migrationsFolder: folder })
  } finally {
    await held`select pg_advisory_unlock(${LOCK_ID})`.catch(() => {})
    held.release()
  }
}
