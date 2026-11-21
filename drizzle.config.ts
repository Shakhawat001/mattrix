import { defineConfig } from "drizzle-kit"

// Used only to generate migrations (pnpm db:generate). The app and the worker apply
// them at start (lib/db/migrate.ts), so this URL is never needed in production.
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://appmetrics:appmetrics@localhost:5432/appmetrics",
  },
})
