"use client"

import { AppWindowIcon } from "lucide-react"
import { usePathname, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { COMPARE_OPTIONS, selectionFrom } from "@/lib/analytics/url"
import { DateRangePicker } from "./date-range-picker"
import { useDashboardNav } from "./navigation"

export type FilterApp = { id: string; label: string; color: string }

const GRANULARITIES = [
  { value: "auto", label: "Auto" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
]

/** The one row of filters above everything it scopes: date range first, then comparison, bucket size and apps. */
export function FilterBar({ apps, today, earliest }: { apps: FilterApp[]; today: string; earliest: string | null }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { update } = useDashboardNav()

  // Numbers over time mean nothing on the Settings page.
  if (pathname.startsWith("/settings")) return null

  const selection = selectionFrom((name) => searchParams.get(name), today, earliest)
  const compare = COMPARE_OPTIONS.some((o) => o.value === searchParams.get("compare")) ? (searchParams.get("compare") as string) : "none"
  const granularity = GRANULARITIES.some((g) => g.value === searchParams.get("gran")) ? (searchParams.get("gran") as string) : "auto"
  const chosenApps = (searchParams.get("apps") ?? "").split(",").filter((id) => apps.some((a) => a.id === id))
  const onOverview = pathname === "/"

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
      <DateRangePicker selection={selection} today={today} onChange={update} />

      <Select
        value={compare}
        items={COMPARE_OPTIONS.map(({ value, label }) => ({ value, label }))}
        onValueChange={(value) => value && update({ compare: value === "none" ? null : value })}
      >
        <SelectTrigger size="sm" className="h-9 min-w-44 border-border px-3 text-xs" aria-label="Compare to">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          {COMPARE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={0}
        value={[granularity]}
        onValueChange={(value) => {
          const next = value[0]
          if (next) update({ gran: next === "auto" ? null : next })
        }}
        aria-label="Group by"
      >
        {GRANULARITIES.map((g) => (
          <ToggleGroupItem key={g.value} value={g.value} className="px-3">
            {g.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {onOverview && apps.length > 1 ? <AppsFilter apps={apps} selected={chosenApps} onChange={(ids) => update({ apps: ids })} /> : null}
    </div>
  )
}

function AppsFilter({ apps, selected, onChange }: { apps: FilterApp[]; selected: string[]; onChange: (ids: string | null) => void }) {
  const everyone = selected.length === 0 || selected.length === apps.length
  const label = everyone ? "All apps" : `${selected.length} of ${apps.length} apps`

  function toggle(id: string) {
    const current = new Set(everyone ? apps.map((a) => a.id) : selected)
    if (current.has(id)) current.delete(id)
    else current.add(id)
    if (current.size === 0) return // at least one app stays
    onChange(current.size === apps.length ? null : [...current].join(","))
  }

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="gap-2" />}>
        <AppWindowIcon aria-hidden />
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-0 p-1.5">
        {apps.map((app) => (
          <label key={app.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted">
            <Checkbox checked={everyone || selected.includes(app.id)} onCheckedChange={() => toggle(app.id)} />
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: app.color }} aria-hidden />
            <span className="truncate">{app.label}</span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  )
}
