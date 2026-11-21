import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getSession } from "@/lib/auth/dal"
import { safeNext } from "@/lib/auth/redirect"
import { BRAND } from "@/lib/brand"
import { LoginForm } from "./login-form"

export const metadata: Metadata = { title: "Log in" }

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams
  // A repeated ?next= arrives as a list; only a single plain value is considered.
  const target = safeNext(typeof next === "string" ? next : undefined)
  if (await getSession()) redirect(target)

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{BRAND.name}</CardTitle>
          <CardDescription>{BRAND.tagline}</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={target === "/" ? undefined : target} />
        </CardContent>
      </Card>
    </main>
  )
}
