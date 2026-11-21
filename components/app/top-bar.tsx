"use client"

import type { ReactNode } from "react"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

/** The sticky row with the sidebar button and the filters. Settings has no filters, so on a wide screen the row goes away. */
export function TopBar({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return (
    <header className={cn("sticky top-0 z-20 flex items-center gap-3 border-b bg-background/85 px-4 py-2.5 backdrop-blur md:px-6", pathname.startsWith("/settings") && "md:hidden")}>
      {children}
    </header>
  )
}
