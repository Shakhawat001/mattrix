"use client"

import type { ReactNode } from "react"
import { usePathname } from "next/navigation"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import type { FilterApp } from "./filter-bar"

/** The page's title: on an app's pages, the app's name and color. */
function titleFor(pathname: string, apps: FilterApp[], fallback: string): { label: string; color?: string } {
  if (pathname === "/") return { label: "All apps" }
  if (pathname.startsWith("/settings")) return { label: "Settings" }
  const id = pathname.startsWith("/apps/") ? decodeURIComponent(pathname.split("/")[2] ?? "") : null
  const app = apps.find((a) => a.id === id)
  return app ? { label: app.label, color: app.color } : { label: fallback }
}

/** The slim row above every page, with the sidebar button, the page's title and the filters. It stays at the top while the page scrolls. */
export function SiteHeader({ apps, brandName, children }: { apps: FilterApp[]; brandName: string; children?: ReactNode }) {
  const title = titleFor(usePathname(), apps, brandName)
  return (
    <header className="@container/header sticky top-0 z-20 flex min-h-(--header-height) shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-background/85 px-4 py-2 backdrop-blur md:rounded-t-xl lg:px-6">
      <div className="flex min-w-0 items-center gap-1 lg:gap-2">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 h-4 data-vertical:self-auto" />
        <h1 className="flex min-w-0 items-center gap-2 text-base font-medium">
          {title.color ? <span className="size-2.5 shrink-0 rounded-full" style={{ background: title.color }} aria-hidden /> : null}
          <span className="truncate">{title.label}</span>
        </h1>
      </div>
      {children}
    </header>
  )
}
