"use client"

import { useActionState, useState } from "react"
import { toast } from "sonner"
import { addConnection, type ActionState } from "@/app/(app)/settings/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const initial: ActionState = {}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs tracking-wider text-muted-foreground uppercase">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function AddConnectionForm({ defaultFrom }: { defaultFrom: string }) {
  // React clears uncontrolled fields after every submission, even a rejected one. These are
  // controlled, so a typo does not cost you the token you just pasted. They stay in the browser
  // and are emptied only when the connection was added.
  const [label, setLabel] = useState("")
  const [partnerId, setPartnerId] = useState("")
  const [token, setToken] = useState("")
  const [backfillFrom, setBackfillFrom] = useState(defaultFrom)
  const [apiVersion, setApiVersion] = useState("2026-07")
  const [appGids, setAppGids] = useState("")

  const [state, action, pending] = useActionState(async (previous: ActionState, formData: FormData) => {
    const result = await addConnection(previous, formData)
    if (result.ok) {
      toast.success(result.ok)
      setLabel("")
      setPartnerId("")
      setToken("")
      setAppGids("")
    }
    return result
  }, initial)

  return (
    <form action={action} className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" hint="Only for you, to tell connections apart.">
          <Input name="label" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} placeholder="My Partner organization" autoComplete="off" />
        </Field>
        <Field label="Partner ID" hint="The number in the address of your Partner Dashboard.">
          <Input name="partnerId" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} required inputMode="numeric" pattern="\d{1,20}" placeholder="1234567" autoComplete="off" />
        </Field>
        <Field label="Partner API token" hint="Stored encrypted. It is never shown again, and this page never sends it back to your browser.">
          <Input name="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} required minLength={16} maxLength={2048} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Read history from" hint="Older events are read once, in the background.">
          <Input name="backfillFrom" type="date" value={backfillFrom} onChange={(e) => setBackfillFrom(e.target.value)} required min="2012-01-01" />
        </Field>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-medium tracking-wider text-muted-foreground uppercase">Advanced</summary>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <Field label="API version" hint="Leave as it is unless Shopify retires it.">
            <Input name="apiVersion" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} pattern="(\d{4}-\d{2}|unstable)" autoComplete="off" />
          </Field>
          <Field label="Only these apps" hint="App IDs like gid://shopify/App/123, separated by commas. Empty reads every app.">
            <Input name="appGids" value={appGids} onChange={(e) => setAppGids(e.target.value)} placeholder="gid://shopify/App/123" autoComplete="off" />
          </Field>
        </div>
      </details>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding" : "Add connection"}
        </Button>
      </div>
    </form>
  )
}
