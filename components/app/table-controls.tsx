"use client"

import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useDashboardNav } from "./navigation"

// Controls that live in the URL, like the date range does. The first option of a select is the
// default and leaves no trace in the URL.

export function ParamSelect({ name, value, options, label, className }: { name: string; value: string; options: { value: string; label: string }[]; label: string; className?: string }) {
  const { update } = useDashboardNav()
  return (
    <Select value={value} items={options} onValueChange={(next) => next && update({ [name]: next === options[0].value ? null : next })}>
      <SelectTrigger size="sm" className={cn("h-9 min-w-36 border-border px-3 text-xs", className)} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A search box that applies on Enter. Keyed by its value so it follows the URL (a back button, a cleared filter). */
export function SearchBox({ name, value, placeholder }: { name: string; value: string; placeholder: string }) {
  const { update } = useDashboardNav()
  return (
    <form
      role="search"
      key={value}
      onSubmit={(event) => {
        event.preventDefault()
        const text = String(new FormData(event.currentTarget).get(name) ?? "").trim().slice(0, 100)
        update({ [name]: text || null })
      }}
    >
      <Input name={name} defaultValue={value} placeholder={placeholder} aria-label={placeholder} autoComplete="off" className="h-9 w-60" />
    </form>
  )
}
