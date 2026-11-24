"use client"

import { useActionState, useState, useTransition } from "react"
import { toast } from "sonner"
import type { ActionState } from "@/app/(app)/settings/actions"
import { addAnnotation, deleteAnnotation } from "@/app/(app)/settings/annotations-actions"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

export type AnnotationItem = {
  id: string
  /** The day, written out for reading. */
  date: string
  /** The app's name, or null for every app. */
  app: string | null
  label: string
  note: string | null
}

const initial: ActionState = {}

function Field({ id, label, hint, children }: { id?: string; label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs tracking-wider text-muted-foreground uppercase">
        {label}
      </Label>
      {children}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

/**
 * The Settings section for annotations: mark a day for one app or for all of them, see every
 * marked day, delete one. `apps` starts with the choice for every app; `dates` bounds the picker.
 */
export function Annotations({ annotations, apps, dates }: { annotations: AnnotationItem[]; apps: { value: string; label: string }[]; dates: { initial: string; min: string; max: string } }) {
  // Controlled, so a rejected label or note is not cleared. Only the label and note are emptied after
  // a save; the date and the app stay, for marking several days in a row.
  const [date, setDate] = useState(dates.initial)
  const [appId, setAppId] = useState(apps[0].value)
  const [label, setLabel] = useState("")
  const [note, setNote] = useState("")

  const [state, action, pending] = useActionState(async (previous: ActionState, formData: FormData) => {
    const result = await addAnnotation(previous, formData)
    if (result.ok) {
      toast.success(result.ok)
      setLabel("")
      setNote("")
    }
    return result
  }, initial)

  return (
    <section aria-labelledby="annotations" className="flex flex-col gap-4">
      <h2 id="annotations" className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        Annotations
      </h2>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Mark a day</CardTitle>
          <CardDescription className="text-xs">A short label on a day, for one app or for all of them: a price change, a release, an App Store feature, an ad campaign. Days are UTC, like every date here.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <form action={action} className="flex flex-col gap-5">
            <input type="hidden" name="appId" value={appId} />
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id="annotation-date" label="Date" hint="Up to a year ahead, for a planned launch.">
                <Input id="annotation-date" name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required min={dates.min} max={dates.max} />
              </Field>
              <Field label="App" hint="All apps, or the one it is about.">
                <Select value={appId} items={apps} onValueChange={(next) => next && setAppId(next)}>
                  <SelectTrigger className="w-full" aria-label="App">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start" alignItemWithTrigger={false}>
                    {apps.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="annotation-label" label="Label" hint="Up to 60 characters.">
                <Input id="annotation-label" name="label" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} placeholder="Price up to $19" autoComplete="off" />
              </Field>
              <Field id="annotation-note" label="Note" hint="Optional. Up to 500 characters.">
                <Textarea id="annotation-note" name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={1} placeholder="Anything to remember about it" className="min-h-10 py-2.5" />
              </Field>
            </div>

            {state.error ? (
              <p role="alert" className="text-sm text-destructive">
                {state.error}
              </p>
            ) : null}

            <div>
              <Button type="submit" disabled={pending}>
                {pending ? "Adding" : "Add annotation"}
              </Button>
            </div>
          </form>

          {annotations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is marked yet.</p>
          ) : (
            <div className="-mx-(--card-spacing) overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>App</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>
                      <span className="sr-only">Delete</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {annotations.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-muted-foreground tabular-nums">{a.date}</TableCell>
                      <TableCell className="text-muted-foreground">{a.app ?? "All apps"}</TableCell>
                      <TableCell className="font-medium">{a.label}</TableCell>
                      <TableCell className="max-w-72 truncate text-muted-foreground" title={a.note ?? undefined}>
                        {a.note ?? ""}
                      </TableCell>
                      <TableCell className="text-right">
                        <DeleteAnnotation annotation={a} />
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

function DeleteAnnotation({ annotation }: { annotation: AnnotationItem }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button size="xs" variant="outline" disabled={pending} aria-label={`Delete ${annotation.label} on ${annotation.date}`} />}>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this annotation?</AlertDialogTitle>
          <AlertDialogDescription>
            &ldquo;{annotation.label}&rdquo; on {annotation.date}, for {annotation.app ?? "all apps"}. No number changes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              setOpen(false)
              startTransition(async () => {
                const result = await deleteAnnotation(annotation.id)
                if (result.error) toast.error(result.error)
                else toast.success(result.ok ?? "Deleted.")
              })
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
