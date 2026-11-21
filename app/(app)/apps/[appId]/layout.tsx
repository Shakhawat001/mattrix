import type { ReactNode } from "react"
import { AppTabs } from "@/components/app/app-tabs"
import { getApps, requireVisibleApp } from "@/lib/analytics/scope"
import { appColors, swatchColor } from "@/lib/analytics/series"
import { formatDate } from "@/lib/analytics/range"

// The frame around every page of one app: its name, where it comes from, and its sections.
export default async function AppSectionLayout({ children, params }: { children: ReactNode; params: Promise<{ appId: string }> }) {
  const { appId } = await params
  const app = await requireVisibleApp(appId)
  const color = swatchColor(appColors(await getApps()), app.id)

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="size-3.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
          <div className="min-w-0">
            <h1 className="truncate font-heading text-2xl font-semibold tracking-wider uppercase">{app.label}</h1>
            <p className="text-xs text-muted-foreground">
              {app.connectionLabel}
              {app.firstEventAt ? `, first activity ${formatDate(app.firstEventAt.toISOString().slice(0, 10))}` : ""}
              {app.label !== app.shopifyName ? `, called "${app.shopifyName}" by Shopify` : ""}
            </p>
          </div>
        </div>
        <AppTabs appId={app.id} />
      </div>
      {children}
    </>
  )
}
