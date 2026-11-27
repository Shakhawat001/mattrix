import type { ReactNode } from "react"
import { AppTabs } from "@/components/app/app-tabs"
import { getTimeZone, requireVisibleApp } from "@/lib/analytics/scope"
import { formatDate } from "@/lib/analytics/range"
import { dayIn } from "@/lib/time-zone"

// The frame around every page of one app: where it comes from, and its sections. Its name is the title in the site header.
export default async function AppSectionLayout({ children, params }: { children: ReactNode; params: Promise<{ appId: string }> }) {
  const { appId } = await params
  const app = await requireVisibleApp(appId)
  const timeZone = await getTimeZone()

  return (
    <>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {app.connectionLabel}
          {app.firstEventAt ? `, first activity ${formatDate(dayIn(app.firstEventAt, timeZone))}` : ""}
          {app.label !== app.shopifyName ? `, called "${app.shopifyName}" by Shopify` : ""}
        </p>
        <AppTabs appId={app.id} />
      </div>
      {children}
    </>
  )
}
