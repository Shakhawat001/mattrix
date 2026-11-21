"use client"

import { useEffect } from "react"
import { WarningIcon } from "@phosphor-icons/react"
import { EmptyState } from "@/components/app/empty-state"
import { Button } from "@/components/ui/button"

// What a page shows when it throws. The message is deliberately generic: Next.js hides the
// real one from the browser, and the digest below matches the line in the server log.
export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <EmptyState icon={<WarningIcon />} title="Something went wrong">
      <p>This page could not be built. Your data is safe. If it keeps happening, check the web container&apos;s log{digest ? ` for ${digest}` : ""}.</p>
      <Button className="mt-4" variant="outline" size="sm" onClick={() => retry()}>
        Try again
      </Button>
    </EmptyState>
  )
}
