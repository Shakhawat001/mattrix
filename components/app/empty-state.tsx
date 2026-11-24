import type { ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        {icon ? <div className="text-muted-foreground [&_svg]:size-8">{icon}</div> : null}
        <h2 className="font-heading text-lg font-semibold">{title}</h2>
        {children ? <div className="max-w-xl text-sm leading-relaxed text-muted-foreground">{children}</div> : null}
      </CardContent>
    </Card>
  )
}
