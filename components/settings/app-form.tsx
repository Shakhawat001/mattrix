"use client"

import { useActionState, useEffect, useState } from "react"
import { toast } from "sonner"
import { updateApp, type ActionState } from "@/app/(app)/settings/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

const initial: ActionState = {}

export type AppFormApp = {
  id: string
  shopifyName: string
  displayName: string | null
  /** A color you chose, or null when it is automatic. */
  color: string | null
  /** What the dashboard shows for it now, to start the color picker on. */
  shownColor: string
  hidden: boolean
  connectionLabel: string
}

export function AppForm({ app }: { app: AppFormApp }) {
  const [state, action, pending] = useActionState(updateApp, initial)
  const [shown, setShown] = useState(!app.hidden)
  const [automatic, setAutomatic] = useState(app.color === null)
  const [name, setName] = useState(app.displayName ?? "")
  const [color, setColor] = useState(app.color ?? hexOf(app.shownColor))

  useEffect(() => {
    if (state.ok) toast.success(state.ok)
    if (state.error) toast.error(state.error)
  }, [state])

  return (
    <form action={action} className="flex flex-wrap items-end gap-x-6 gap-y-4 py-4">
      <input type="hidden" name="appId" value={app.id} />
      <input type="hidden" name="hidden" value={shown ? "false" : "true"} />

      <div className="flex min-w-56 flex-1 flex-col gap-1">
        <Label htmlFor={`name-${app.id}`} className="text-xs tracking-wider text-muted-foreground uppercase">
          Name
        </Label>
        <Input id={`name-${app.id}`} name="displayName" value={name} onChange={(e) => setName(e.target.value)} placeholder={app.shopifyName} maxLength={60} autoComplete="off" />
        <p className="text-xs text-muted-foreground">{app.connectionLabel}. Leave empty to use Shopify&apos;s name.</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-xs tracking-wider text-muted-foreground uppercase">Color</Label>
        <div className="flex h-9 items-center gap-3">
          <input
            type="color"
            name="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            disabled={automatic}
            aria-label={`Color for ${app.shopifyName}`}
            className="h-8 w-10 cursor-pointer border border-input bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
          />
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={automatic} onCheckedChange={(v) => setAutomatic(Boolean(v))} />
            Automatic
          </label>
        </div>
      </div>

      <div className="flex h-9 items-center gap-3">
        <Switch checked={shown} onCheckedChange={setShown} id={`show-${app.id}`} aria-label={`Show ${app.shopifyName} in the dashboard`} />
        <Label htmlFor={`show-${app.id}`} className="text-sm">
          Show in the dashboard
        </Label>
      </div>

      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving" : "Save"}
      </Button>
    </form>
  )
}

/** A CSS variable such as var(--series-2) cannot start a color picker, so start it on a plain gray. */
const hexOf = (value: string) => (/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#898781")
