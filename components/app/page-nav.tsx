import Link from "next/link"
import { ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon, type LucideIcon } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { formatInt } from "@/lib/format"
import { cn } from "@/lib/utils"

/** "51 to 100 of 312", the page, and buttons to the first, previous, next and last pages. Plain links, so it works without JavaScript. */
export function PageNav({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)

  const step = (target: number, label: string, Icon: LucideIcon, enabled: boolean, className?: string) => {
    const classes = cn(buttonVariants({ variant: "outline", size: "icon-sm" }), className)
    const content = (
      <>
        <span className="sr-only">{label}</span>
        <Icon aria-hidden />
      </>
    )
    return enabled ? (
      <Link href={hrefFor(target)} className={classes}>
        {content}
      </Link>
    ) : (
      <span aria-disabled className={cn(classes, "pointer-events-none opacity-50")}>
        {content}
      </span>
    )
  }

  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-4 px-4 text-sm">
      <span className="flex-1 text-muted-foreground tabular-nums">{total === 0 ? "Nothing to show" : `${formatInt(first)} to ${formatInt(last)} of ${formatInt(total)}`}</span>
      <div className="flex items-center gap-4 lg:gap-8">
        <span className="hidden font-medium tabular-nums sm:inline">
          Page {formatInt(page)} of {formatInt(pages)}
        </span>
        <div className="flex items-center gap-2">
          {step(1, "Go to the first page", ChevronsLeftIcon, page > 1, "hidden lg:inline-flex")}
          {step(page - 1, "Go to the previous page", ChevronLeftIcon, page > 1)}
          {step(page + 1, "Go to the next page", ChevronRightIcon, page < pages)}
          {step(pages, "Go to the last page", ChevronsRightIcon, page < pages, "hidden lg:inline-flex")}
        </div>
      </div>
    </nav>
  )
}
