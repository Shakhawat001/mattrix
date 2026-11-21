import type { AppInfo } from "./queries"

// Which color an app wears in a chart. Two rules from the dataviz guidance:
//
//   1. Color follows the entity, never its rank. Filtering apps in or out must not repaint
//      the ones that stay, so a slot is handed out by when an app was created, counting
//      every app (hidden ones too), not by its place in the list on screen.
//   2. There are eight hues and they are never cycled or generated. An app past the eighth
//      folds into one gray "Other" series in the charts, unless you chose it a color in
//      Settings. It still has its own row in every table.

export const SLOT_COUNT = 8
export const OTHER_KEY = "other"
export const OTHER_COLOR = "var(--series-other)"
const HEX = /^#[0-9a-fA-F]{6}$/

export type SeriesDef = { key: string; label: string; color: string }

export const slotColor = (slot: number): string => `var(--series-${slot + 1})`

type ColorInput = Pick<AppInfo, "id" | "color" | "createdAt">

/** App id to color. Null means the app has no color of its own and folds into "Other". */
export function appColors(all: ColorInput[]): Map<string, string | null> {
  const ordered = [...all].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
  return new Map(ordered.map((app, slot) => [app.id, app.color && HEX.test(app.color) ? app.color : slot < SLOT_COUNT ? slotColor(slot) : null]))
}

/** The color to paint a swatch for an app: its own, or the gray "Other". */
export const swatchColor = (colors: Map<string, string | null>, appId: string): string => colors.get(appId) ?? OTHER_COLOR

export type AppSeries = {
  /** One series per app that has a color, then one "Other" if any app has none. */
  series: SeriesDef[]
  /** Which series an app's numbers belong to. */
  keyOf: (appId: string) => string
}

export function appSeries(apps: Pick<AppInfo, "id" | "label">[], colors: Map<string, string | null>): AppSeries {
  const series: SeriesDef[] = []
  let hasOther = false
  for (const app of apps) {
    const color = colors.get(app.id)
    if (color) series.push({ key: app.id, label: app.label, color })
    else hasOther = true
  }
  if (hasOther) series.push({ key: OTHER_KEY, label: "Other apps", color: OTHER_COLOR })
  return { series, keyOf: (appId) => (colors.get(appId) ? appId : OTHER_KEY) }
}

/** The fixed colors for the metrics that appear together in a chart, so "Churn" is the same hue on every page. */
export const MOVEMENT_SERIES: (SeriesDef & { metric: "newMrrCents" | "expansionMrrCents" | "contractionMrrCents" | "churnedMrrCents"; sign: 1 | -1 })[] = [
  { key: "new", label: "New", metric: "newMrrCents", sign: 1, color: slotColor(0) },
  { key: "expansion", label: "Expansion", metric: "expansionMrrCents", sign: 1, color: slotColor(1) },
  { key: "contraction", label: "Contraction", metric: "contractionMrrCents", sign: -1, color: slotColor(2) },
  { key: "churn", label: "Churn", metric: "churnedMrrCents", sign: -1, color: slotColor(3) },
]
