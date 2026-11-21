import { Skeleton } from "@/components/ui/skeleton"

// Shown while a page loads for the first time. Changing a filter does not come through here:
// the page on screen stays put, dimmed, until the new numbers are ready.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy aria-label="Loading">
      <Skeleton className="h-8 w-56" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    </div>
  )
}
