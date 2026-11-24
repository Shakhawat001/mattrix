import { ApiTokenManager, type ApiTokenView } from "@/components/settings/api-tokens"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDate } from "@/lib/analytics/range"
import { MAX_ACTIVE_API_TOKENS, listApiTokens } from "@/lib/auth/api-tokens"
import { requireSession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db/client"
import { formatAgo } from "@/lib/format"

const day = (date: Date) => formatDate(date.toISOString().slice(0, 10))

/** The API tokens part of Settings. It reads the tokens itself, so it checks the session itself. */
export async function ApiTokensSection() {
  await requireSession()
  const now = new Date()
  const tokens: ApiTokenView[] = (await listApiTokens(getDb())).map((t) => {
    const expired = t.expiresAt !== null && t.expiresAt.getTime() <= now.getTime()
    return {
      id: t.id,
      name: t.name,
      hint: t.hint,
      hideShops: t.hideShops,
      created: day(t.createdAt),
      lastUsed: t.lastUsedAt ? formatAgo(t.lastUsedAt, now) : "Never",
      expires: t.expiresAt === null ? "Never" : expired ? `Expired ${day(t.expiresAt)}` : day(t.expiresAt),
      expired,
    }
  })
  const active = tokens.filter((t) => !t.expired).length

  return (
    <section aria-labelledby="api-tokens" className="flex flex-col gap-4">
      <h2 id="api-tokens" className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        API tokens
      </h2>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Tokens for AI agents</CardTitle>
          <CardDescription className="text-xs">
            For AI agents that read these numbers. A token is shown once, when you create it, and only a hash of it is stored. Changing SESSION_SECRET ends every token. {active} of{" "}
            {MAX_ACTIVE_API_TOKENS} active.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiTokenManager tokens={tokens} />
        </CardContent>
      </Card>
    </section>
  )
}
