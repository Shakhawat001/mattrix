import { fileURLToPath } from "node:url"
import { createDatabase, type Database } from "@/lib/db/client"
import { runMigrations } from "@/lib/db/migrate"

// Integration tests run against a real Postgres, because the SQL is part of what is being
// tested. Point TEST_DATABASE_URL at a throwaway database; without it they are skipped:
//
//   docker run -d --rm --name appmetrics-test-db -e POSTGRES_USER=appmetrics \
//     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=appmetrics_test -p 127.0.0.1:55433:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://appmetrics:test@127.0.0.1:55433/appmetrics_test pnpm test

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
export const hasDatabase = Boolean(TEST_DATABASE_URL)

export async function openTestDatabase(): Promise<Database> {
  const database = createDatabase(TEST_DATABASE_URL as string, { max: 4 })
  await runMigrations(database, fileURLToPath(new URL("../../drizzle", import.meta.url)))
  return database
}

/** Empties every table, so each test starts from nothing. */
export async function clearAll(database: Database): Promise<void> {
  await database.sql`truncate table events, installs, subscriptions, trials, daily_metrics, sync_runs, apps, connections, sessions, login_attempts restart identity cascade`
}
