import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { renderMetricsDoc } from "@/lib/analytics/metrics-doc"
import { METRICS } from "@/lib/analytics/metrics-registry"

describe("docs/METRICS.md", () => {
  it("is the file the registry produces. If this fails, run: pnpm docs:metrics", () => {
    expect(readFileSync("docs/METRICS.md", "utf8")).toBe(renderMetricsDoc())
  })

  it("lists every metric once", () => {
    const text = renderMetricsDoc()
    for (const def of Object.values(METRICS)) expect(text.split(`| ${def.label} |`).length - 1, def.label).toBe(1)
  })

  it("has no em or en dashes", () => {
    expect(renderMetricsDoc()).not.toMatch(/[—–]/)
  })
})
