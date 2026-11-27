import { awaitingRebuild } from "@/lib/analytics/queries"
import { getApps, getTimeZone } from "@/lib/analytics/scope"

/**
 * Says so while the worker rebuilds the daily numbers for a newly picked time zone, when charts
 * still count days the old way next to figures already counted the new way. Each page renders
 * it rather than the layout: Next.js does not render a layout again on navigation, so a tab that
 * was open before the change would never show it. Both reads are cached for the request.
 */
export async function RebuildNotice() {
  const [all, timeZone] = await Promise.all([getApps(), getTimeZone()])
  if (!awaitingRebuild(all.filter((a) => !a.hidden), timeZone)) return null
  return (
    <p role="status" className="border-l-2 border-primary bg-muted px-4 py-3 text-sm leading-relaxed text-muted-foreground">
      The numbers are being rebuilt with days in {timeZone}. Until that is done, some charts still count days the old way. It usually takes under a minute, longer while a sync is running. Refresh the page to see the rebuilt numbers.
    </p>
  )
}
