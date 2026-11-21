"use client"

import type { Key } from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts"
import { ChartContainer } from "@/components/ui/chart"
import { bucketLabel, type Granularity } from "@/lib/analytics/range"
import { bucketTitle, type ChartData, type Datum } from "@/lib/analytics/view"
import { formatAxis, formatValue } from "@/lib/format"
import type { SeriesDef } from "@/lib/analytics/series"

export type ChartKind =
  /** Several measures over time, one line each (stocks such as MRR or active installs). */
  | "line"
  /** One measure over time with a faint wash under it. */
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
    <div className="min-w-44 bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <p className="mb-1.5 font-medium text-muted-foreground">{bucketTitle(String(label), granularity)}</p>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="h-0.5 w-3 shrink-0" style={{ background: row.color }} aria-hidden />
              {row.label}
            </span>
            <span className="font-semibold text-foreground tabular-nums">{formatValue(row.value, data.format)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TimeChart({ data, kind, granularity, height = 256 }: { data: ChartData; kind: ChartKind; granularity: Granularity; height?: number }) {
  const points: Datum[] = data.compare ? data.points.map((p, i) => ({ ...p, [COMPARE_KEY]: data.compare!.values[i] ?? (null as unknown as number) })) : data.points
  const last = points.length - 1
  const order = data.series.map((s) => s.key)

  const axes = (
    <>
      <CartesianGrid vertical={false} stroke={GRID} />
      <XAxis
        dataKey="bucket"
        tickLine={false}
        axisLine={{ stroke: GRID }}
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
    <Line dataKey={COMPARE_KEY} type="linear" stroke="var(--muted-foreground)" strokeWidth={1.5} dot={false} activeDot={false} isAnimationActive={false} connectNulls />
  ) : null

  const margin = { top: 8, right: 12, bottom: 0, left: 0 }
  const lineFor = (s: SeriesDef) => (
    <Line key={s.key} dataKey={s.key} type="linear" stroke={s.color} strokeWidth={2} dot={endDot(s.color, last)} activeDot={{ r: 4, fill: s.color, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} />
  )

  return (
    <ChartContainer config={{}} className="aspect-auto w-full" style={{ height }}>
      {kind === "line" ? (
        <LineChart data={points} margin={margin}>
          {axes}
          {data.series.map(lineFor)}
          {compareLine}
        </LineChart>
      ) : kind === "area" ? (
        <AreaChart data={points} margin={margin}>
          {axes}
          {data.series.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="linear"
              stroke={s.color}
              strokeWidth={2}
              fill={s.color}
              fillOpacity={0.1}
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
