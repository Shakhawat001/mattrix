"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { MAX_ACTIVE_API_TOKENS, createApiToken, revokeApiToken } from "@/lib/auth/api-tokens"
import { requireSession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db/client"
import { getEnv } from "@/lib/env"
import type { ActionState } from "./actions"

// Like every action, each starts with requireSession() and validates its input. A new token is
// returned once, in the answer to the request that made it, and is never stored or logged.

export type CreateTokenState = ActionState & { token?: string }

const tokenInput = z.object({
  name: z.string().trim().min(1, "Give the token a name.").max(60, "Keep the name under 60 characters."),
  expiry: z.enum(["never", "30", "90", "365"], "Pick when the token expires."),
  hideShops: z.enum(["true", "false"]),
})

export async function createApiTokenAction(_previous: CreateTokenState, formData: FormData): Promise<CreateTokenState> {
  await requireSession()

  const parsed = tokenInput.safeParse({
    name: formData.get("name"),
    expiry: formData.get("expiry"),
    hideShops: formData.get("hideShops") ?? "false",
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." }
  const { name, expiry, hideShops } = parsed.data

  const created = await createApiToken(getDb(), getEnv().sessionSecret, {
    name,
    expiresInDays: expiry === "never" ? null : Number(expiry),
    hideShops: hideShops === "true",
  })
  if (!created.ok) return { error: `That is the limit of ${MAX_ACTIVE_API_TOKENS} active tokens. Revoke one you no longer use first.` }

  revalidatePath("/settings")
  return { ok: "Token created.", token: created.token }
}

export async function revokeApiTokenAction(tokenId: string): Promise<ActionState> {
  await requireSession()
  if (!z.uuid().safeParse(tokenId).success) return { error: "Unknown token." }

  if (!(await revokeApiToken(getDb(), tokenId))) return { error: "Unknown token." }
  revalidatePath("/settings")
  return { ok: "Revoked. An agent using it is refused from its next request." }
}
