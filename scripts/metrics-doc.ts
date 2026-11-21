// Rewrites docs/METRICS.md from the metric registry:  pnpm docs:metrics
import { writeFileSync } from "node:fs"
import { renderMetricsDoc } from "@/lib/analytics/metrics-doc"

writeFileSync("docs/METRICS.md", renderMetricsDoc())
console.log("docs/METRICS.md written")
