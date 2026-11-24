"use client"

import { useActionState, useState, useTransition } from "react"
import { toast } from "sonner"
import type { ActionState } from "@/app/(app)/settings/actions"
import { excludeShop, removeExclusion } from "@/app/(app)/settings/excluded-shops-actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export type ExcludedShopItem = { shop: string; note: string | null; added: string }

const initial: ActionState = {}

/** The Settings section for shops left out of every number: add one with a note, see the list, remove one. */
export function ExcludedShops({ shops }: { shops: ExcludedShopItem[] }) {
  const [shop, setShop] = useState("")
  const [note, setNote] = useState("")
  const [removing, startTransition] = useTransition()

  const [state, action, pending] = useActionState(async (previous: ActionState, formData: FormData) => {
    const result = await excludeShop(previous, formData)
    if (result.ok) {
      toast.success(result.ok)
      setShop("")
      setNote("")
    }
    return result
  }, initial)

  const remove = (domain: string) =>
    startTransition(async () => {
      const result = await removeExclusion(domain)
      if (result.error) toast.error(result.error)
      else toast.success(result.ok ?? "Done.")
    })

  return (
    <section aria-labelledby="excluded-shops" className="flex flex-col gap-4">
      <h2 id="excluded-shops" className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        Excluded shops
      </h2>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Left out of every number</CardTitle>
          <CardDescription className="text-xs">
            For your own development stores, test installs and Shopify&apos;s review stores. An excluded shop counts in no number of any app. Its events stay stored and still show in the event log, so removing it from this list brings it back. The numbers are recomputed within a minute of a change.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <form action={action} className="flex flex-wrap items-end gap-x-6 gap-y-4">
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <Label htmlFor="excluded-shop" className="text-xs tracking-wider text-muted-foreground uppercase">
                Shop
              </Label>
              <Input id="excluded-shop" name="shop" value={shop} onChange={(e) => setShop(e.target.value)} required maxLength={300} placeholder="my-dev-store.myshopify.com" autoComplete="off" spellCheck={false} />
              <p className="text-xs text-muted-foreground">Its myshopify.com address, as the shop list shows it. The handle alone works too.</p>
            </div>
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <Label htmlFor="excluded-note" className="text-xs tracking-wider text-muted-foreground uppercase">
                Note
              </Label>
              <Input id="excluded-note" name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Development store" autoComplete="off" />
              <p className="text-xs text-muted-foreground">Optional. Only for you, to remember why.</p>
            </div>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Excluding" : "Exclude"}
            </Button>
          </form>

          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}

          {shops.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shops are excluded. Every shop counts.</p>
          ) : (
            <div className="-mx-(--card-spacing) overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Shop</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Excluded on</TableHead>
                    <TableHead>
                      <span className="sr-only">Remove</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shops.map((s) => (
                    <TableRow key={s.shop}>
                      <TableCell className="font-medium">{s.shop}</TableCell>
                      <TableCell className="max-w-72 truncate text-muted-foreground" title={s.note ?? undefined}>
                        {s.note ?? ""}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{s.added}</TableCell>
                      <TableCell className="text-right">
                        <Button size="xs" variant="outline" disabled={removing} onClick={() => remove(s.shop)} aria-label={`Remove ${s.shop} from the list`}>
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
