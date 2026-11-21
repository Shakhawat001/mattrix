import Link from "next/link"
import { buttonVariants } from "@/components/ui/button"
import { formatInt } from "@/lib/format"
import { cn } from "@/lib/utils"

/** "51 to 100 of 312" with Previous and Next. Plain links, so it works without JavaScript. */
export function PageNav({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)
  const button = buttonVariants({ variant: "outline", size: "sm" })

  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
      <span className="tabular-nums">{total === 0 ? "Nothing to show" : `${formatInt(first)} to ${formatInt(last)} of ${formatInt(total)}`}</span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={hrefFor(page - 1)} className={button}>
            Previous
          </Link>
        ) : (
          <span aria-disabled className={cn(button, "pointer-events-none opacity-50")}>
            Previous
          </span>
        )}
        {page < pages ? (
          <Link href={hrefFor(page + 1)} className={button}>
            Next
          </Link>
        ) : (
          <span aria-disabled className={cn(button, "pointer-events-none opacity-50")}>
            Next
          </span>
        )}
      </div>
    </nav>
  )
}
