"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { excludeShop } from "@/app/(app)/settings/excluded-shops-actions"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** Leaves a shop out of every number, after asking. `excluded`: it already is, and leaves the list at the next rebuild. */
export function ExcludeShopButton({ shop, excluded }: { shop: string; excluded: boolean }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState("")
  const [pending, startTransition] = useTransition()

  if (excluded) {
    return (
      <span className="text-xs text-muted-foreground" title="It leaves this list when the numbers are recomputed, within a minute.">
        Excluded
      </span>
    )
  }

  const confirm = () => {
    setOpen(false)
    startTransition(async () => {
      const form = new FormData()
      form.set("shop", shop)
      form.set("note", note)
      const result = await excludeShop({}, form)
      if (result.error) toast.error(result.error)
      else toast.success(result.ok ?? "Done.")
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button size="xs" variant="ghost" disabled={pending} aria-label={`Exclude ${shop}`} />}>Exclude</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Exclude this shop?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium break-all text-foreground">{shop}</span> will count in no number of any app. Use this for your own development stores, test installs and review stores. Its events stay stored, and you can bring it back in Settings. The numbers are recomputed within a minute.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`exclude-note-${shop}`} className="text-xs tracking-wider text-muted-foreground uppercase">
            Note, optional
          </Label>
          <Input id={`exclude-note-${shop}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Development store" autoComplete="off" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep counting it</AlertDialogCancel>
          <AlertDialogAction onClick={confirm}>Exclude</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
