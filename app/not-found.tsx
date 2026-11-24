import Link from "next/link"
import { buttonVariants } from "@/components/ui/button"

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="font-heading text-2xl font-semibold">Nothing here</h1>
      <p className="max-w-sm text-sm text-muted-foreground">That page does not exist, or that app is hidden or has been removed.</p>
      <Link href="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
        Back to all apps
      </Link>
    </main>
  )
}
