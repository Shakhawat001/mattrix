import { describe, expect, it } from "vitest"
import { createPartnerClient } from "@/lib/partner/client"

const answer = (body: unknown) =>
  createPartnerClient({ partnerId: "42", token: "secret-token-value", sleep: async () => {}, fetch: async () => new Response(JSON.stringify(body)) })

describe("Partner API errors", () => {
  it("explains, in plain words, an organization that does not have the events feature yet", async () => {
    const error = (await answer({ errors: [{ message: "Feature not enabled for this organization" }] })
      .query("query { events { edges { cursor } } }", {})
      .catch((e: unknown) => e)) as Error
    expect(error.message).toContain("Feature not enabled")
    expect(error.message).toContain("not on for this one yet")
  })

  it("passes any other error through as Shopify worded it, and never with the token in it", async () => {
    const error = (await answer({ errors: [{ message: "Something about secret-token-value went wrong" }] })
      .query("query { x }", {})
      .catch((e: unknown) => e)) as Error
    expect(error.message).toContain("Something about [token] went wrong")
    expect(error.message).not.toContain("secret-token-value")
    expect(error.message).not.toContain("not on for this one yet")
  })
})
