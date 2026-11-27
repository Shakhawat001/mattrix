"use client"

import { startTransition, useActionState, useEffect, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { updateTimeZone, type ActionState } from "@/app/(app)/settings/actions"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

const initial: ActionState = {}

export type ZoneOption = { value: string; label: string }

// The browser's own zone, offered as a one-click choice. It is read only in the browser, after
// hydration (the server render gets null), so the server's HTML and the first render agree.
const never = () => () => {}
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || null

/** Two names for one zone (Asia/Calcutta and Asia/Kolkata) count as the same. */
function sameZone(a: string, b: string): boolean {
  try {
    const canonical = (zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone
    return canonical(a) === canonical(b)
  } catch {
    return a === b
  }
}

export function TimeZoneForm({ current, zones }: { current: string; zones: ZoneOption[] }) {
  const [state, action, pending] = useActionState(updateTimeZone, initial)
  // Controlled, so a rejected save does not reset the choice. When a save goes through, the page
  // comes back with the zone as the server spelled it, and the choice follows it. The form submits
  // through onSubmit, not `action`: React resets a form after a form action, and a controlled
  // select does not survive that reset (it would show the zone the page loaded with).
  const [value, setValue] = useState(current)
  const [saved, setSaved] = useState(current)
  if (saved !== current) {
    setSaved(current)
    setValue(current)
  }
  const browser = useSyncExternalStore(never, browserZone, () => null)

  useEffect(() => {
    if (state.ok) toast.success(state.ok)
    if (state.error) toast.error(state.error)
  }, [state])

  // The browser may spell its zone in a way this server's list does not (Asia/Kolkata). It is still
  // offered; the server checks it and saves it in its own spelling.
  const options = zones.some((z) => z.value === value) ? zones : [{ value, label: value }, ...zones]
  const suggestion = browser && !sameZone(browser, value) && !sameZone(browser, current) ? browser : null

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        startTransition(() => action(data))
      }}
      className="flex flex-col gap-2"
    >
      <Label htmlFor="time-zone" className="text-xs tracking-wider text-muted-foreground uppercase">
        Time zone
      </Label>
      <div className="flex flex-wrap items-end gap-3">
        <select
          id="time-zone"
          name="timeZone"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby="time-zone-hint"
          className="h-10 w-full max-w-80 min-w-0 border border-transparent border-b-input bg-transparent py-1 text-base outline-none focus-visible:border-b-ring md:text-sm dark:[color-scheme:dark]"
        >
          {options.map((zone) => (
            <option key={zone.value} value={zone.value}>
              {zone.label}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={pending || value === current}>
          {pending ? "Saving" : "Save"}
        </Button>
      </div>
      <p id="time-zone-hint" className="text-xs text-muted-foreground">
        Days run from midnight to midnight in this zone, and every time is shown on its clock. Changing it rebuilds the daily numbers, which usually takes under a minute and longer while a sync is running.
      </p>
      {suggestion ? (
        <p className="text-xs text-muted-foreground">
          Your browser is set to {suggestion}.{" "}
          <button type="button" onClick={() => setValue(suggestion)} className="font-medium text-foreground underline underline-offset-4">
            Use {suggestion}
          </button>
        </p>
      ) : null}
    </form>
  )
}
