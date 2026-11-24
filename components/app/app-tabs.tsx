"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { carriedQuery } from "@/lib/analytics/url"
import { cn } from "@/lib/utils"

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

/** The sections of one app. The range and comparison follow you from tab to tab. */
export function AppTabs({ appId }: { appId: string }) {
  const pathname = usePathname()
  const carry = carriedQuery(useSearchParams())

  return (
    <nav aria-label="Sections of this app" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b">
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
            className={cn(
              "-mb-px border-b-2 px-3 py-2.5 text-xs font-semibold tracking-widest whitespace-nowrap uppercase outline-none transition-colors focus-visible:text-foreground",
              active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
