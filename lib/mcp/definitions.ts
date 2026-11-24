import { BETTER, CONVENTIONS, SOURCES, UNIT } from "@/lib/analytics/metrics-doc"
import { COHORT_METRICS, METRICS, type MetricDef } from "@/lib/analytics/metrics-registry"
import { BRAND } from "@/lib/brand"
import { OUTPUT_RULES } from "./output"

// What get_definitions and the definitions resource say: the conventions and the metric table from
// the registry, the same text docs/METRICS.md and the dashboard's tooltips show, plus how the tools
// write numbers. The resource is the same content as markdown.

export const DEFINITIONS_URI = "appmetrics://definitions"

export type MetricDefinition = {
  /** The registry's key, which the tools use for the metric. */
  id: string
  label: string
  /** range: a figure for a date range. cohort: follows a group of shops from the range up to today. */
  group: "range" | "cohort"
  unit: string
  better_when: string
  description: string
}

const define = (id: string, def: MetricDef, group: MetricDefinition["group"]): MetricDefinition => ({
  id,
  label: def.label,
  group,
  unit: UNIT[def.format],
  better_when: BETTER[def.good],
  description: def.description,
})

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  ...Object.entries(METRICS).map(([id, def]) => define(id, def, "range")),
  ...Object.entries(COHORT_METRICS).map(([id, def]) => define(id, def, "cohort")),
]

export const METRIC_IDS = METRIC_DEFINITIONS.map((m) => m.id) as [string, ...string[]]

/** The conventions as plain sentences, without the markdown emphasis. */
export const CONVENTION_TEXT: readonly string[] = CONVENTIONS.map((c) => c.replaceAll("**", ""))

export function renderDefinitionsMarkdown(): string {
  const rows = METRIC_DEFINITIONS.map((m) => `| ${m.id} | ${m.label} | ${m.description} | ${m.unit} | ${m.better_when} |`)
  const cohorts = METRIC_DEFINITIONS.filter((m) => m.group === "cohort").map((m) => m.label.toLowerCase())
  const cohortList = cohorts.length > 1 ? `${cohorts.slice(0, -1).join(", ")} and ${cohorts.at(-1)}` : cohorts.join("")

  return `# Metric definitions

What every number from ${BRAND.name} means. The dashboard's tooltips read the same definitions.

## Conventions

${CONVENTIONS.map((c) => `- ${c}`).join("\n")}

## How the tools write numbers

${OUTPUT_RULES.map((r) => `- ${r}`).join("\n")}

## The numbers

| Id | Metric | What it is | Unit | Better when |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

Every metric is a figure for a date range except ${cohortList}, which follow a group of shops from the range up to today.

## Where the numbers come from

${SOURCES}
`
}
