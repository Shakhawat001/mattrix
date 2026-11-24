"use client"

import { useState } from "react"
import { CalendarIcon, CheckIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { PRESETS, formatRange, isDate } from "@/lib/analytics/range"
import type { RangeSelection } from "@/lib/analytics/url"

// The calendar works in the browser's local time and the dashboard in UTC days. A date is
// only ever carried between them as a "YYYY-MM-DD" string, built from local parts on both
// sides, so a day never shifts.
const toDate = (iso: string) => {
  const [year, month, day] = iso.split("-").map(Number)
  return new Date(year, month - 1, day)
}
const toIso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`

type Props = {
  selection: RangeSelection
  /** The latest day with data, in UTC. Nothing after it can be picked. */
  today: string
  onChange: (updates: Record<string, string | null>) => void
}

export function DateRangePicker({ selection, today, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange | undefined>()

  function onOpenChange(next: boolean) {
    // Start from what is on screen each time it opens, so a half-made pick is never kept.
    if (next) setDraft({ from: toDate(selection.range.from), to: toDate(selection.range.to) })
    setOpen(next)
  }

  function pickPreset(key: string) {
    onChange({ preset: key, from: null, to: null })
    setOpen(false)
  }

  function apply() {
    if (!draft?.from) return
    const a = toIso(draft.from)
    const b = toIso(draft.to ?? draft.from)
    onChange({ preset: null, from: a <= b ? a : b, to: a <= b ? b : a })
    setOpen(false)
  }

  function typed(edge: "from" | "to", value: string) {
    if (!isDate(value)) return
    const date = toDate(value)
    setDraft((current) => {
      const from = edge === "from" ? date : (current?.from ?? date)
      const to = edge === "to" ? date : (current?.to ?? date)
      return from <= to ? { from, to } : { from: date, to: date }
    })
  }

  const draftFrom = draft?.from ? toIso(draft.from) : ""
  const draftTo = draft?.to ? toIso(draft.to) : draftFrom
  const calendarMonth = draft?.to ?? draft?.from ?? toDate(today)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="gap-2" />}>
        <CalendarIcon aria-hidden />
        <span>{selection.label}</span>
        {selection.presetKey ? <span className="hidden font-normal tracking-normal text-muted-foreground normal-case lg:inline">{formatRange(selection.range)}</span> : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-1.5rem)] gap-0 p-0">
        <div className="flex flex-col sm:flex-row">
          <ul className="flex flex-row gap-0 overflow-x-auto border-b p-1.5 sm:w-48 sm:flex-col sm:border-r sm:border-b-0" aria-label="Presets">
            {PRESETS.map((preset) => (
              <li key={preset.key} className="shrink-0">
                <button
                  type="button"
                  onClick={() => pickPreset(preset.key)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm whitespace-nowrap outline-none hover:bg-muted focus-visible:bg-muted"
                >
                  {preset.label}
                  {selection.presetKey === preset.key ? <CheckIcon strokeWidth={2.5} className="size-4" aria-label="Selected" /> : null}
                </button>
              </li>
            ))}
          </ul>

          <div className="flex flex-col">
            <Calendar
              mode="range"
              numberOfMonths={2}
              selected={draft}
              onSelect={setDraft}
              defaultMonth={new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1)}
              disabled={{ after: toDate(today) }}
              captionLayout="dropdown"
              startMonth={new Date(2012, 0)}
              endMonth={toDate(today)}
            />
            <div className="flex flex-wrap items-end gap-3 border-t p-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="range-from">
                  From
                </Label>
                <Input id="range-from" type="date" value={draftFrom} max={today} onChange={(e) => typed("from", e.target.value)} className="h-9 w-40" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="range-to">
                  To
                </Label>
                <Input id="range-to" type="date" value={draftTo} max={today} onChange={(e) => typed("to", e.target.value)} className="h-9 w-40" />
              </div>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={apply} disabled={!draft?.from}>
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
