import type { ReactNode } from "react"

/**
 * The top of a page: its description and actions. The site header already shows the page's
 * title as the h1, so a title here is a heading under it: the app pages name their section.
 */
export function PageHeader({ title, description, actions, level = 2 }: { title?: string; description?: ReactNode; actions?: ReactNode; level?: 2 | 3 }) {
  const Heading = level === 2 ? "h2" : "h3"
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {title ? <Heading className="font-heading text-xl font-semibold">{title}</Heading> : null}
        {description ? <p className={title ? "mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground" : "max-w-2xl text-sm leading-relaxed text-muted-foreground"}>{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** A heading for a group of cards on a page. On an app's page, under its h2, it is an h3. */
export function SectionTitle({ children, description, level = 2 }: { children: ReactNode; description?: ReactNode; level?: 2 | 3 }) {
  const Heading = level === 2 ? "h2" : "h3"
  return (
    <div className="flex flex-col gap-0.5">
      <Heading className="font-heading text-base font-medium">{children}</Heading>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
  )
}

/** A short note on a page: a caveat, or what to do about an empty result. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="border-l-2 border-primary bg-muted px-4 py-3 text-sm leading-relaxed text-muted-foreground">{children}</p>
}
