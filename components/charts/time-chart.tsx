"use client"

import { useId, type Key } from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts"
import { ChartContainer } from "@/components/ui/chart"
import { bucketLabel, type Granularity } from "@/lib/analytics/range"
import { bucketTitle, type ChartData, type Datum } from "@/lib/analytics/view"
import { formatAxis, formatValue } from "@/lib/format"

export type ChartKind =
  /** Several measures over time, one line each with a light wash under it (stocks such as MRR or active installs). */
  | "line"
  /** One measure over time with a deeper wash under it. */
  | "area"
  /** Flows that add up to a whole, stacked above the zero line. */
  | "stack"
  /** Gains above the zero line and losses below it. */
  | "diverge"

const COMPARE_KEY = "__compare"
const SURFACE = "var(--card)"
const GRID = "var(--border)"

type SegmentProps = { x: number; y: number; width: number; height: number; fill: string; payload: Datum; dataKey: string }

const roundedTop = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`
const roundedBottom = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x},${y} L${x + w},${y} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} Z`

/**
 * One segment of a stacked column. Only the outermost segment on each side of zero has
 * rounded corners (the data end); everything touching the baseline or another segment is
 * square. A 2px stroke in the card color is the gap between segments, not a border.
 */
function Segment({ x, y, width, height, fill, payload, dataKey, order }: SegmentProps & { order: string[] }) {
  if (!width || !height) return null
  const value = Number(payload[dataKey])
  if (!value) return null
  const sameSide = order.filter((key) => Math.sign(Number(payload[key])) === Math.sign(value))
  const isEnd = sameSide[sameSide.length - 1] === dataKey
  const top = Math.min(y, y + height)
  const h = Math.abs(height)
  const r = isEnd ? Math.min(4, width / 2, h) : 0
  return <path d={value > 0 ? roundedTop(x, top, width, h, r) : roundedBottom(x, top, width, h, r)} fill={fill} stroke={SURFACE} strokeWidth={2} />
}

/** A marker on the last point only, with a ring in the card color so it stays legible over a line. */
function endDot(color: string, last: number) {
  return function EndDot(props: { cx?: number; cy?: number; index?: number; key?: Key | null }) {
    if (props.index !== last || props.cx === undefined || props.cy === undefined) return <g key={props.key} />
    return <circle key={props.key} cx={props.cx} cy={props.cy} r={4} fill={color} stroke={SURFACE} strokeWidth={2} />
  }
}

type TooltipEntry = { dataKey?: string | number; value?: number | string | null }

/** One readout for every series at the hovered bucket: values lead, names follow. */
function SeriesTooltip({
  active,
  payload,
  label,
  data,
  granularity,
  kind,
}: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  data: ChartData
  granularity: Granularity
  kind: ChartKind
}) {
  if (!active || !payload?.length) return null

  const rows = payload
    .filter((entry) => entry.value !== null && entry.value !== undefined)
    .map((entry) => {
      const key = String(entry.dataKey)
      const series = data.series.find((s) => s.key === key)
      const isCompare = key === COMPARE_KEY
      return {
        key,
        label: isCompare ? (data.compare?.label ?? "Before") : (series?.label ?? key),
        color: isCompare ? "var(--muted-foreground)" : (series?.color ?? "var(--muted-foreground)"),
        value: Number(entry.value),
      }
    })

  // Stacks read top to bottom like the columns do (gains outermost first, then losses nearest
  // the zero line first); lines read highest first.
  if (kind === "line") rows.sort((a, b) => b.value - a.value)
  else if (kind === "stack") rows.reverse()
  else if (kind === "diverge") rows.splice(0, rows.length, ...rows.filter((r) => r.value >= 0).reverse(), ...rows.filter((r) => r.value < 0))

  return (
    <div className="grid min-w-44 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <p className="font-medium">{bucketTitle(String(label), granularity)}</p>
      <ul className="grid gap-1.5">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className={row.key === COMPARE_KEY ? "h-0.5 w-2.5 shrink-0" : "size-2.5 shrink-0 rounded-[2px]"} style={{ background: row.color }} aria-hidden />
              {row.label}
            </span>
            <span className="font-medium text-foreground tabular-nums">{formatValue(row.value, data.format)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TimeChart({ data, kind, granularity, height = 256 }: { data: ChartData; kind: ChartKind; granularity: Granularity; height?: number }) {
  // Gradient ids must be unique on the page, and React's ids hold characters a url(#...) reference cannot.
  const gradient = `fill${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const points: Datum[] = data.compare ? data.points.map((p, i) => ({ ...p, [COMPARE_KEY]: data.compare!.values[i] ?? (null as unknown as number) })) : data.points
  const last = points.length - 1
  const order = data.series.map((s) => s.key)

  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey="bucket"
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        minTickGap={32}
        tickFormatter={(bucket: string) => bucketLabel(bucket, granularity)}
      />
      <YAxis width={56} tickLine={false} axisLine={false} tickMargin={4} tickFormatter={(v: number) => formatAxis(v, data.format)} />
      <Tooltip
        isAnimationActive={false}
        cursor={kind === "stack" || kind === "diverge" ? { fill: "var(--muted)", fillOpacity: 0.5 } : { stroke: GRID, strokeWidth: 1 }}
        content={<SeriesTooltip data={data} granularity={granularity} kind={kind} />}
      />
    </>
  )

  const compareLine = data.compare ? (
    <Line dataKey={COMPARE_KEY} type="monotone" stroke="var(--muted-foreground)" strokeWidth={1.5} dot={false} activeDot={false} isAnimationActive={false} connectNulls />
  ) : null

  const margin = { top: 8, right: 12, bottom: 0, left: 0 }
  // One measure gets a deep wash. Several overlap, so theirs is light enough to read every line through.
  const [washTop, washBottom] = kind === "area" ? [0.5, 0.05] : [0.2, 0.02]

  return (
    <ChartContainer config={{}} className="aspect-auto w-full" style={{ height }}>
      {kind === "line" || kind === "area" ? (
        <AreaChart data={points} margin={margin}>
          <defs>
            {data.series.map((s, i) => (
              <linearGradient key={s.key} id={`${gradient}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={s.color} stopOpacity={washTop} />
                <stop offset="95%" stopColor={s.color} stopOpacity={washBottom} />
              </linearGradient>
            ))}
          </defs>
          {axes}
          {data.series.map((s, i) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={s.color}
              strokeWidth={2}
              fill={`url(#${gradient}-${i})`}
              dot={endDot(s.color, last)}
              activeDot={{ r: 4, fill: s.color, stroke: SURFACE, strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
          {compareLine}
        </AreaChart>
      ) : (
        <BarChart data={points} margin={margin} stackOffset="sign">
          {axes}
          {kind === "diverge" ? <ReferenceLine y={0} stroke={GRID} /> : null}
          {data.series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="stack"
              fill={s.color}
              maxBarSize={24}
              isAnimationActive={false}
              shape={(props: unknown) => <Segment {...(props as SegmentProps)} order={order} />}
            />
          ))}
        </BarChart>
      )}
    </ChartContainer>
  )
}
