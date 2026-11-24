import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { cohortRetention } from "@/lib/analytics/aggregate"
import { COHORT_METRICS, METRICS } from "@/lib/analytics/metrics-registry"
import { revenueCohortRows } from "@/lib/analytics/revenue-cohorts"

describe("revenue cohort rows", () => {
  const starts = [
    { cohort: "2026-02-01", shops: 1, startMrr: 5000 },
    { cohort: "2026-01-01", shops: 2, startMrr: 3000 },
  ]
  const held = [
    { cohort: "2026-01-01", k: 0, shops: 2, mrr: 3000 },
    { cohort: "2026-01-01", k: 1, shops: 2, mrr: 4500 },
    { cohort: "2026-02-01", k: 0, shops: 1, mrr: 2500 },
  ]

  it("puts cohorts oldest first and divides what each still pays by what it started with", () => {
    const rows = revenueCohortRows(starts, held, "2026-03-15", 4)
    expect(rows.map((r) => r.cohort)).toEqual(["2026-01-01", "2026-02-01"])
    expect(rows[0]).toMatchObject({ shops: 2, startMrr: 3000 })
    expect(rows[0].cells[0]).toEqual({ mrr: 3000, shops: 2, share: 1 })
    // Upgrades count: 4500 of the 3000 it started with is 150%.
    expect(rows[0].cells[1]).toEqual({ mrr: 4500, shops: 2, share: 1.5 })
    expect(rows[1].cells[0]).toEqual({ mrr: 2500, shops: 1, share: 0.5 })
  })

  it("leaves a cell empty until its month is over", () => {
    // On 15 March, January has passed months 0 and 1, February only month 0.
    const rows = revenueCohortRows(starts, held, "2026-03-15", 4)
    expect(rows[0].cells.map((c) => c !== null)).toEqual([true, true, false, false])
    expect(rows[1].cells.map((c) => c !== null)).toEqual([true, false, false, false])
  })

  it("shows a month on its last day, as the install cohorts do", () => {
    const today = "2026-01-31"
    const [revenue] = revenueCohortRows([{ cohort: "2026-01-01", shops: 1, startMrr: 1000 }], [{ cohort: "2026-01-01", k: 0, shops: 1, mrr: 1000 }], today, 2)
    const [installs] = cohortRetention([{ installedAt: new Date("2026-01-05T12:00:00Z"), uninstalledAt: null }], "month", new Date(`${today}T12:00:00Z`), 2)
    expect(revenue.cells.map((c) => c !== null)).toEqual(installs.cells.map((c) => c !== null))
    expect(revenue.cells.map((c) => c !== null)).toEqual([true, false])
  })

  it("reads a month that is over with nothing counted as nobody paying", () => {
    const [row] = revenueCohortRows([{ cohort: "2026-01-01", shops: 2, startMrr: 3000 }], [], "2026-06-01", 2)
    expect(row.cells).toEqual([
      { mrr: 0, shops: 0, share: 0 },
      { mrr: 0, shops: 0, share: 0 },
    ])
  })

  it("has no share when there is nothing to divide by", () => {
    const [row] = revenueCohortRows([{ cohort: "2026-01-01", shops: 1, startMrr: 0 }], [{ cohort: "2026-01-01", k: 0, shops: 0, mrr: 0 }], "2026-06-01", 1)
    expect(row.cells[0]?.share).toBeNull()
  })

  it("has twelve months unless told otherwise, and nothing for no cohorts", () => {
    expect(revenueCohortRows([{ cohort: "2026-01-01", shops: 1, startMrr: 1000 }], [], "2026-02-10")[0].cells).toHaveLength(12)
    expect(revenueCohortRows([], [], "2026-02-10")).toEqual([])
  })
})

describe("the cohort metrics in the registry", () => {
  it("defines each with a label, a format and a plain definition", () => {
    for (const [id, def] of Object.entries(COHORT_METRICS)) {
      expect(def.label, id).toBeTruthy()
      expect(def.description.length, id).toBeGreaterThan(20)
      expect(["int", "money", "percent", "days"]).toContain(def.format)
      expect(["up", "down", "none"]).toContain(def.good)
      expect(def.description, id).not.toMatch(/[—–]| - /)
    }
  })

  it("shares no id or label with the KPIs", () => {
    for (const id of Object.keys(COHORT_METRICS)) expect(Object.keys(METRICS), id).not.toContain(id)
    const labels = Object.values(METRICS).map((m) => m.label as string)
    for (const def of Object.values(COHORT_METRICS)) expect(labels, def.label).not.toContain(def.label)
  })

  it("is written into docs/METRICS.md once each", () => {
    const text = readFileSync("docs/METRICS.md", "utf8")
    for (const def of Object.values(COHORT_METRICS)) expect(text.split(`| ${def.label} |`).length - 1, def.label).toBe(1)
  })
})
