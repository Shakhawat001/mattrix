// A tiny trend line for a stat tile. Drawn on the server as plain SVG: the line in the
// recessive text color, the current end in the accent. It is decoration (the tile's number
// and change carry the meaning), so it is hidden from screen readers.

const MAX_POINTS = 60

/** At most `max` values, evenly spaced, always keeping the last one. */
function sample(values: number[], max: number): number[] {
  if (values.length <= max) return values
  const out: number[] = []
  for (let i = 0; i < max - 1; i++) out.push(values[Math.round((i * (values.length - 1)) / (max - 1))])
  out.push(values[values.length - 1])
  return out
}

export function Sparkline({ values, width = 96, height = 36, color = "var(--series-1)" }: { values: number[]; width?: number; height?: number; color?: string }) {
  const data = sample(values, MAX_POINTS)
  if (data.length < 2) return null

  const pad = 5 // room for the end dot and its ring
  const min = Math.min(...data)
  const max = Math.max(...data)
  const flat = max === min
  const x = (i: number) => pad + (i / (data.length - 1)) * (width - 2 * pad)
  const y = (v: number) => (flat ? height / 2 : pad + (1 - (v - min) / (max - min)) * (height - 2 * pad))

  const line = data.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ")
  const area = `${line} L${x(data.length - 1).toFixed(1)} ${height} L${x(0).toFixed(1)} ${height} Z`

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="shrink-0 overflow-visible">
      <path d={area} fill={color} opacity={0.1} />
      <path d={line} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r={3.5} fill={color} stroke="var(--card)" strokeWidth={2} />
    </svg>
  )
}
