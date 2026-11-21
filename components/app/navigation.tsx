"use client"

import { createContext, useCallback, useContext, useMemo, useTransition, type ReactNode } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { withParams } from "@/lib/analytics/url"
import { cn } from "@/lib/utils"

// The filters live in the URL. Changing one pushes a new URL inside a transition, so the
// page on screen stays put (dimmed) until the new one is ready: no skeleton flash and no
// layout jump while the numbers reload.

type Navigation = {
  /** True while the next page is loading. */
  pending: boolean
  /** Sets or removes query params on the current page. A null value removes one. */
  update: (updates: Record<string, string | null>) => void
}

const NavigationContext = createContext<Navigation | null>(null)

export function NavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const update = useCallback(
    (updates: Record<string, string | null>) => {
      const query = withParams(searchParams, updates).toString()
      startTransition(() => router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }))
    },
    [router, pathname, searchParams],
  )

  const value = useMemo(() => ({ pending, update }), [pending, update])
  return <NavigationContext value={value}>{children}</NavigationContext>
}

export function useDashboardNav(): Navigation {
  const context = useContext(NavigationContext)
  if (!context) throw new Error("useDashboardNav must be used inside <NavigationProvider>")
  return context
}

/** Wraps the page content: dims it and ignores clicks while new numbers load. */
export function PendingFrame({ children, className }: { children: ReactNode; className?: string }) {
  const { pending } = useDashboardNav()
  return (
    <div aria-busy={pending} className={cn("transition-opacity duration-150", pending && "pointer-events-none opacity-60", className)}>
      {children}
    </div>
  )
}
