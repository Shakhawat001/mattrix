import type { ReactNode } from "react"
import { AppTabs } from "@/components/app/app-tabs"
import { requireVisibleApp } from "@/lib/analytics/scope"
import { formatDate } from "@/lib/analytics/range"

// The frame around every page of one app: where it comes from, and its sections. Its name is the title in the site header.
export default async function AppSectionLayout({ children, params }: { children: ReactNode; params: Promise<{ appId: string }> }) {
  const { appId } = await params
  const app = await requireVisibleApp(appId)

  return (
    <>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {app.connectionLabel}
          {app.firstEventAt ? `, first activity ${formatDate(app.firstEventAt.toISOString().slice(0, 10))}` : ""}
          {app.label !== app.shopifyName ? `, called "${app.shopifyName}" by Shopify` : ""}
        </p>
        <AppTabs appId={app.id} />
      </div>
      {children}
    </>
  )
}
