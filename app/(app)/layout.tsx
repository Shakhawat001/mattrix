import Link from "next/link"
import type { CSSProperties, ReactNode } from "react"
import { AppSidebar } from "@/components/app/app-sidebar"
import { FilterBar, type FilterApp } from "@/components/app/filter-bar"
import { NavigationProvider, PendingFrame } from "@/components/app/navigation"
import { SiteHeader } from "@/components/app/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { requireSession } from "@/lib/auth/dal"
import { earliestDate } from "@/lib/analytics/queries"
import { todayUtc } from "@/lib/analytics/range"
import { getApps } from "@/lib/analytics/scope"
import { appColors, swatchColor } from "@/lib/analytics/series"
import { BRAND } from "@/lib/brand"
import { getDb } from "@/lib/db/client"
import { getEnv } from "@/lib/env"

// Everything behind the login. requireSession() is the real gate: the proxy only checks
// that a cookie exists, so this is where the session is checked against the database.
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireSession()

  const all = await getApps()
  const visible = all.filter((a) => !a.hidden)
  const colors = appColors(all)
  const apps: FilterApp[] = visible.map((a) => ({ id: a.id, label: a.label, color: swatchColor(colors, a.id) }))
  const earliest = await earliestDate(getDb(), visible.map((a) => a.id))
  const demo = all.some((a) => a.isDemo)

  return (
    <NavigationProvider>
      <SidebarProvider style={{ "--sidebar-width": "calc(var(--spacing) * 72)", "--header-height": "calc(var(--spacing) * 12)" } as CSSProperties}>
        <AppSidebar variant="inset" apps={apps} brandName={BRAND.name} user={getEnv().user} />
        <SidebarInset className="min-w-0">
          <SiteHeader apps={apps} brandName={BRAND.name}>
            <FilterBar apps={apps} today={todayUtc()} earliest={earliest} />
          </SiteHeader>
          {demo ? (
            <p className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground lg:px-6">
              You are looking at invented demo data. It is not from Shopify.{" "}
              <Link href="/settings" className="font-medium text-foreground underline underline-offset-4">
                Remove it in Settings
              </Link>
              .
            </p>
          ) : null}
          <PendingFrame className="@container/main flex flex-1 flex-col">
            <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:gap-6 lg:p-6">{children}</div>
          </PendingFrame>
        </SidebarInset>
      </SidebarProvider>
    </NavigationProvider>
  )
}
