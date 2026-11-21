import { NextResponse } from "next/server"
import { getDatabase } from "@/lib/db/client"

// Liveness for Docker and for the proxy. Public by design, so it says nothing about
// what is wrong: only whether the database answers.
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await getDatabase().sql`select 1`
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ status: "error" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
