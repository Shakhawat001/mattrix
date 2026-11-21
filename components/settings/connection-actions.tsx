"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { removeConnection, requestSync, setPaused, type ActionState } from "@/app/(app)/settings/actions"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

export function ConnectionActions({ id, label, paused, isDemo }: { id: string; label: string; paused: boolean; isDemo: boolean }) {
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState(false)

  const run = (work: () => Promise<ActionState>) =>
    startTransition(async () => {
      const result = await work()
      if (result.error) toast.error(result.error)
      else toast.success(result.ok ?? "Done.")
    })

  return (
    <div className="flex flex-wrap gap-2">
      {isDemo ? null : (
        <>
          <Button size="xs" variant="outline" disabled={pending || paused} onClick={() => run(() => requestSync(id))}>
            Sync now
          </Button>
          <Button size="xs" variant="outline" disabled={pending} onClick={() => run(() => setPaused(id, !paused))}>
            {paused ? "Resume" : "Pause"}
          </Button>
        </>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogTrigger render={<Button size="xs" variant="destructive" disabled={pending} />}>Remove</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isDemo ? "Remove the demo data?" : `Remove ${label}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {isDemo
                ? "The invented apps and all their numbers are deleted."
                : "Its apps, the events read through it and every number built from them are deleted from this dashboard. Nothing changes in Shopify. Adding the connection again reads the history again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                run(() => removeConnection(id))
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
