// Bundles the worker and the CLI into single files (dist/worker.mjs, dist/cli.mjs), so
// the Docker image runs them with plain `node` and needs no TypeScript tooling. The
// web server is built by Next.js; this covers everything else that runs in production.

import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

await build({
  absWorkingDir: root,
  tsconfig: path.join(root, "tsconfig.json"), // resolves the "@/..." imports
  entryPoints: { worker: "worker/index.ts", cli: "cli/index.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  // Some dependencies are CommonJS and call require().
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
})
