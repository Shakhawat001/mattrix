"use client"

import { createContext, useActionState, useContext, useState, useTransition } from "react"
import { toast } from "sonner"
import { createApiTokenAction, revokeApiTokenAction, type CreateTokenState } from "@/app/(app)/settings/api-token-actions"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

/** A token as the list shows it. The dates are written on the server, in UTC. */
export type ApiTokenView = {
  id: string
  name: string
  hint: string
  hideShops: boolean
  created: string
  lastUsed: string
  expires: string
  expired: boolean
}

const EXPIRY = [
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In a year" },
  { value: "never", label: "Never" },
]

const initial: CreateTokenState = {}

type CreatedToken = { name: string; token: string }

const NewTokenContext = createContext<{ created: CreatedToken | null; setCreated: (next: CreatedToken | null) => void } | null>(null)

/** Holds a token just created, for the box that shows it and for the setup in ConnectAi. Done, or leaving the page, forgets it. */
export function NewTokenProvider({ children }: { children: React.ReactNode }) {
  const [created, setCreated] = useState<CreatedToken | null>(null)
  return <NewTokenContext value={{ created, setCreated }}>{children}</NewTokenContext>
}

export function useNewToken() {
  const value = useContext(NewTokenContext)
  if (!value) throw new Error("useNewToken needs a NewTokenProvider around it.")
  return value
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function ApiTokenManager({ tokens }: { tokens: ApiTokenView[] }) {
  return (
    <div className="flex flex-col gap-6">
      <CreateToken />
      <TokenList tokens={tokens} />
    </div>
  )
}

function CreateToken() {
  const [name, setName] = useState("")
  const [expiry, setExpiry] = useState("90")
  const [hideShops, setHideShops] = useState(false)
  const { created, setCreated } = useNewToken()

  const [state, action, pending] = useActionState(async (previous: CreateTokenState, formData: FormData): Promise<CreateTokenState> => {
    const result = await createApiTokenAction(previous, formData)
    if (result.token) {
      setCreated({ name: String(formData.get("name") ?? "").trim(), token: result.token })
      setName("")
    }
    // The token is kept only for the box below and the setup that fills it in, so closing the box forgets it.
    return { ok: result.ok, error: result.error }
  }, initial)

  return (
    <div className="flex flex-col gap-5">
      {created ? <NewToken name={created.name} token={created.token} onDone={() => setCreated(null)} /> : null}

      <form action={action} className="flex flex-col gap-5">
        <input type="hidden" name="expiry" value={expiry} />
        <input type="hidden" name="hideShops" value={hideShops ? "true" : "false"} />

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Name" htmlFor="api-token-name" hint="Only for you, to tell tokens apart.">
            <Input id="api-token-name" name="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Claude Code on my laptop" autoComplete="off" />
          </Field>
          <Field label="Expires" hint="From then on the token is refused.">
            <Select value={expiry} items={EXPIRY} onValueChange={(next) => next && setExpiry(next)}>
              <SelectTrigger className="h-9 w-full border-border px-3 text-sm" aria-label="Expires">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                {EXPIRY.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <Checkbox checked={hideShops} onCheckedChange={(v) => setHideShops(Boolean(v))} className="mt-0.5" />
          <span className="flex flex-col gap-0.5">
            Hide shop domains
            <span className="text-xs text-muted-foreground">An agent using this token sees a stable alias, such as shop_3f9a1c2b7e, in place of each shop&apos;s address.</span>
          </span>
        </label>

        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating" : "Create token"}
          </Button>
        </div>
      </form>
    </div>
  )
}

function NewToken({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(token)
      toast.success("Copied.")
    } catch {
      toast.error("The browser did not allow copying. Select the token and copy it yourself.")
    }
  }

  return (
    <div role="status" className="flex flex-col gap-3 border-l-2 border-primary bg-muted px-4 py-3">
      <p className="text-sm leading-relaxed">
        The token for {name}. Copy it now: it is not shown again, and only a hash of it is stored. The setup under Connect an AI has it filled in until you click Done.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input readOnly value={token} aria-label={`The token for ${name}`} onFocus={(e) => e.currentTarget.select()} spellCheck={false} className="min-w-72 flex-1 font-mono text-xs" />
        <Button type="button" size="sm" onClick={copy}>
          Copy
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

function TokenList({ tokens }: { tokens: ApiTokenView[] }) {
  if (tokens.length === 0) return <p className="text-sm text-muted-foreground">No tokens yet.</p>
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-muted">
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Token</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Shop domains</TableHead>
            <TableHead>
              <span className="sr-only">Revoke</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="max-w-56 truncate font-medium" title={t.name}>
                {t.name}
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {"amt_••••"}
                {t.hint}
              </TableCell>
              <TableCell className="text-muted-foreground">{t.created}</TableCell>
              <TableCell className="text-muted-foreground">{t.lastUsed}</TableCell>
              <TableCell className={t.expired ? "text-destructive" : "text-muted-foreground"}>{t.expires}</TableCell>
              <TableCell className="text-muted-foreground">{t.hideShops ? "Hidden" : "Shown"}</TableCell>
              <TableCell className="text-right">
                <RevokeToken id={t.id} name={t.name} expired={t.expired} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function RevokeToken({ id, name, expired }: { id: string; name: string; expired: boolean }) {
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState(false)
  const verb = expired ? "Remove" : "Revoke"

  return (
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogTrigger render={<Button size="xs" variant="destructive" disabled={pending} />}>{verb}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {verb} {name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {expired
              ? "It has expired already. This takes it off the list."
              : "An agent using it is refused from its next request. This cannot be undone: to give the agent access again, create a new token."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              setConfirming(false)
              startTransition(async () => {
                const result = await revokeApiTokenAction(id)
                if (result.error) toast.error(result.error)
                else toast.success(result.ok ?? "Done.")
              })
            }}
          >
            {verb}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
