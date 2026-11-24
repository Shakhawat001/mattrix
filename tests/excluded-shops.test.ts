import { describe, expect, it } from "vitest"
import { normalizeShop } from "@/lib/analytics/excluded-shops"

describe("normalizeShop", () => {
  it("writes a shop as events store it: the myshopify.com domain in lower case", () => {
    expect(normalizeShop("my-store.myshopify.com")).toBe("my-store.myshopify.com")
    expect(normalizeShop("  My-Store.MyShopify.com ")).toBe("my-store.myshopify.com")
  })

  it("takes what is easy to paste: an address with a path, an admin address, or the handle alone", () => {
    expect(normalizeShop("https://my-store.myshopify.com/admin/apps?x=1")).toBe("my-store.myshopify.com")
    expect(normalizeShop("https://admin.shopify.com/store/my-store/apps")).toBe("my-store.myshopify.com")
    expect(normalizeShop("admin.shopify.com/store/my-store")).toBe("my-store.myshopify.com")
    expect(normalizeShop("my-store")).toBe("my-store.myshopify.com")
  })

  it("refuses anything that cannot be a shop in the events, a custom domain included", () => {
    for (const input of ["", "   ", "mystore.com", "www.mystore.com", "my store", "a.b.myshopify.com", "myshopify.com", ".myshopify.com", "-store.myshopify.com", "https://admin.shopify.com/", "admin.shopify.com/apps", "%.myshopify.com"]) {
      expect(normalizeShop(input), input).toBeNull()
    }
    expect(normalizeShop(`${"a".repeat(64)}.myshopify.com`)).toBeNull()
  })
})
