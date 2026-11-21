import { isIP } from "node:net"

/**
 * The address of whoever is making the request, for rate limiting and the session log.
 *
 * Behind a reverse proxy every connection comes from the proxy, so the real
 * address is in X-Forwarded-For. Each proxy appends the address it saw to the
 * right-hand end, and a client can put anything it likes at the left-hand end. So
 * the entry to trust is counted from the right: with one proxy (Coolify's) it is
 * the last one, with two it is the second to last. Taking the first entry, as many
 * examples do, lets an attacker pick a new "address" for every attempt.
 *
 * With `trustProxy` off the header is ignored and the address is unknown, which
 * makes the per-address limit shared by everyone; the per-username and global
 * limits still apply. The same "unknown" is used when the header has fewer entries
 * than there are proxies, or the entry is not an address: anything to its left was
 * written by the client, so falling back to it would let a client pick its address.
 */
export function clientIp(headers: Pick<Headers, "get">, trustProxy: boolean, hops = 1): string {
  if (!trustProxy) return "unknown"
  const forwarded = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  if (forwarded.length < hops) return "unknown"
  const candidate = forwarded[forwarded.length - hops]
  return isIP(candidate) ? candidate : "unknown"
}

/**
 * The address as the login limiter counts it. An IPv6 address stands for its /64, the block a
 * home or a server is usually given, so counting through it does not give an attacker a fresh
 * address for every guess. An IPv4 address written in IPv6 form is that IPv4 address.
 */
export function addressBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip
  const groups = ipv6Groups(ip.split("%")[0].toLowerCase())
  if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") {
    const hi = parseInt(groups[6] ?? "0", 16)
    const lo = parseInt(groups[7] ?? "0", 16)
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".")
  }
  return `${groups.slice(0, 4).join(":")}::/64`
}

/** The eight groups of an IPv6 address, with `::` and a dotted IPv4 tail expanded and leading zeros dropped. */
function ipv6Groups(address: string): string[] {
  let text = address
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)?.[1]
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.split(".").map(Number)
    text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const parts = text.split("::")
  const left = parts[0] ? parts[0].split(":") : []
  const right = parts.length > 1 && parts[1] ? parts[1].split(":") : []
  const zeros = parts.length > 1 ? Array<string>(8 - left.length - right.length).fill("0") : []
  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16).toString(16))
}
