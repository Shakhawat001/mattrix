import { describe, expect, it } from "vitest"
import { addressBucket, clientIp } from "@/lib/auth/client-ip"
import { loginKeys } from "@/lib/auth/rate-limit"

const headers = (values: Record<string, string>) => new Headers(values)

describe("the client's address", () => {
  it("counts proxies from the right of X-Forwarded-For", () => {
    expect(clientIp(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), true, 1)).toBe("203.0.113.7")
    expect(clientIp(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2" }), true, 2)).toBe("203.0.113.7")
  })

  it("is unknown when there are fewer entries than proxies, instead of trusting what the client wrote", () => {
    expect(clientIp(headers({ "x-forwarded-for": "6.6.6.6" }), true, 2)).toBe("unknown")
    expect(clientIp(headers({}), true, 1)).toBe("unknown")
  })

  it("is unknown when the trusted entry is not an address", () => {
    expect(clientIp(headers({ "x-forwarded-for": "6.6.6.6, not-an-ip" }), true, 1)).toBe("unknown")
  })

  it("never falls back to X-Real-IP, which a client can set", () => {
    expect(clientIp(headers({ "x-real-ip": "6.6.6.6" }), true, 1)).toBe("unknown")
    expect(clientIp(headers({ "x-forwarded-for": "junk", "x-real-ip": "6.6.6.6" }), true, 1)).toBe("unknown")
  })

  it("ignores the headers altogether when the app is not behind a proxy", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7" }), false, 1)).toBe("unknown")
  })

  it("accepts IPv6", () => {
    expect(clientIp(headers({ "x-forwarded-for": "2001:db8::1" }), true, 1)).toBe("2001:db8::1")
  })
})

describe("the address the login limiter counts", () => {
  it("keeps an IPv4 address, and unknown, as they are", () => {
    expect(addressBucket("203.0.113.7")).toBe("203.0.113.7")
    expect(addressBucket("unknown")).toBe("unknown")
  })

  it("counts every IPv6 address in a /64 as one, however it is written", () => {
    const bucket = addressBucket("2001:db8:1:2::a")
    expect(bucket).toBe("2001:db8:1:2::/64")
    expect(addressBucket("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(bucket)
    expect(addressBucket("2001:db8:1:2:3:4:5:6")).toBe(bucket)
    expect(addressBucket("2001:db8:1:3::a")).not.toBe(bucket)
  })

  it("expands :: wherever it sits", () => {
    expect(addressBucket("::1")).toBe("0:0:0:0::/64")
    expect(addressBucket("2001:db8::")).toBe("2001:db8:0:0::/64")
    expect(addressBucket("fe80::1:2:3:4")).toBe("fe80:0:0:0::/64")
  })

  it("reads an IPv4 address written in IPv6 form as the IPv4 address", () => {
    expect(addressBucket("::ffff:203.0.113.7")).toBe("203.0.113.7")
    expect(addressBucket("::ffff:cb00:7107")).toBe("203.0.113.7")
  })

  it("is what the login limiter keys on", () => {
    expect(loginKeys("2001:db8:1:2::a", "owner")[0]).toBe(loginKeys("2001:db8:1:2:ffff::1", "owner")[0])
    expect(loginKeys("203.0.113.7", "owner")[0]).toBe("ip:203.0.113.7")
  })
})
