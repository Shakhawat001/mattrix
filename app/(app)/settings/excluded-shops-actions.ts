"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { addExcludedShop, normalizeShop, removeExcludedShop } from "@/lib/analytics/excluded-shops"
import { requireSession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db/client"
import { log } from "@/lib/log"
import type { ActionState } from "./actions"

// The excluded shops, from Settings and from the shop list. Like every action these start with
// requireSession(), because a Server Action is a public POST endpoint. They only change the list
// and mark every app dirty; the worker recomputes the numbers.

const RECOMPUTED = "The numbers are recomputed within a minute."
const NOT_A_SHOP = "Use the shop's myshopify.com address, as the shop list shows it."

const exclusionInput = z.object({
  shop: z.string().max(300, NOT_A_SHOP),
  note: z.string().trim().max(200, "Keep the note under 200 characters."),
})

/** Marking every app dirty waits while the worker rebuilds one, which rarely takes long. If it does, nothing is saved. */
async function saved<T>(work: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await work() }
  } catch (err) {
    log.warn("changing the excluded shops failed", { error: err instanceof Error ? err.message : String(err) })
    return { error: "That was not saved. Try again in a minute." }
  }
}

export async function excludeShop(_previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession()

  const parsed = exclusionInput.safeParse({ shop: formData.get("shop") ?? "", note: formData.get("note") ?? "" })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_A_SHOP }
  const shop = normalizeShop(parsed.data.shop)
  if (!shop) return { error: NOT_A_SHOP }

  const result = await saved(() => addExcludedShop(getDb(), shop, parsed.data.note || null))
  if ("error" in result) return result
  revalidatePath("/", "layout")
  return { ok: result.value ? `${shop} is excluded from every number. ${RECOMPUTED}` : `${shop} was already excluded.` }
}

export async function removeExclusion(shop: string): Promise<ActionState> {
  await requireSession()

  const parsed = z.string().max(300).safeParse(shop)
  const domain = parsed.success ? normalizeShop(parsed.data) : null
  if (!domain) return { error: "Unknown shop." }

  const result = await saved(() => removeExcludedShop(getDb(), domain))
  if ("error" in result) return result
  revalidatePath("/", "layout")
  return result.value ? { ok: `${domain} counts again. ${RECOMPUTED}` } : { error: "That shop is not excluded." }
}
