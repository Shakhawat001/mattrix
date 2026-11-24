"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { carriedQuery } from "@/lib/analytics/url"

const TABS = [
  { slug: "", label: "Overview" },
  { slug: "growth", label: "Growth" },
  { slug: "revenue", label: "Revenue" },
  { slug: "retention", label: "Retention" },
  { slug: "trials", label: "Trials" },
  { slug: "churn", label: "Churn" },
  { slug: "shops", label: "Shops" },
  { slug: "events", label: "Events" },
]

/** The sections of one app, drawn like a tab list. The range and comparison follow you from tab to tab. */
export function AppTabs({ appId }: { appId: string }) {
  const pathname = usePathname()
  const carry = carriedQuery(useSearchParams())

  return (
    <nav aria-label="Sections of this app" className="flex h-9 w-fit max-w-full items-center overflow-x-auto overflow-y-hidden rounded-4xl bg-muted p-[3px] text-muted-foreground">
      {TABS.map((tab) => {
        const path = `/apps/${appId}${tab.slug ? `/${tab.slug}` : ""}`
        // A page inside a section, such as one shop's timeline, keeps its section's tab lit.
        const current = pathname === path
        const active = current || (tab.slug !== "" && pathname.startsWith(`${path}/`))
        return (
          <Link
            key={tab.slug}
            href={`${path}${carry}`}
            aria-current={current ? "page" : active ? "true" : undefined}
            data-active={active || undefined}
            className="inline-flex h-full items-center justify-center rounded-xl border border-transparent px-3 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-active:bg-background data-active:text-foreground data-active:shadow-sm dark:text-muted-foreground dark:hover:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground"
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
