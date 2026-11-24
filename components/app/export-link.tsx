import { DownloadIcon } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"

/** A link to a CSV download. The route checks the session itself, so the link can be shown anywhere behind the login. */
export function ExportLink({ params, label = "Export CSV" }: { params: Record<string, string | undefined>; label?: string }) {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) if (value) query.set(name, value)
  return (
    <a href={`/api/export?${query.toString()}`} download className={buttonVariants({ variant: "outline", size: "sm" })}>
      <DownloadIcon aria-hidden />
      {label}
    </a>
  )
}
