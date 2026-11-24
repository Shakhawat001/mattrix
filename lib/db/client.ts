import type { PgDatabase } from "drizzle-orm/pg-core"
import { drizzle, type PostgresJsDatabase, type PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js"
import postgres, { type Sql } from "postgres"
import { getEnv } from "@/lib/env"
import * as schema from "./schema"

export type Db = PostgresJsDatabase<typeof schema>
/** The pool or a transaction on it, so a read can run inside a caller's transaction. */
export type Queryable = PgDatabase<PostgresJsQueryResultHKT, typeof schema>
export type Database = { sql: Sql; db: Db; close: () => Promise<void> }

/** Opens a pool. The app, the worker and the tests each make their own. */
export function createDatabase(url: string, options: { max?: number; statementTimeoutMs?: number } = {}): Database {
  const sql = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
    ...(options.statementTimeoutMs ? { connection: { statement_timeout: options.statementTimeoutMs } } : {}),
  })
  return { sql, db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) }
}

// One pool per process. In development Next reloads modules, so it lives on globalThis.
const globalForDb = globalThis as unknown as { __appmetricsDb?: Database }

export function getDatabase(): Database {
  // Pages read; nothing a page asks for should take 30 seconds. The worker's pool has no limit.
  return (globalForDb.__appmetricsDb ??= createDatabase(getEnv().databaseUrl, { statementTimeoutMs: 30_000 }))
}

export function getDb(): Db {
  return getDatabase().db
}
