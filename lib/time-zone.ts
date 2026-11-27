// The dashboard's time zone, and the only place an instant becomes a calendar day or a day
// becomes an instant. A day is written "YYYY-MM-DD" and runs from its first instant in the zone
// to the first instant of the next day: 23 or 25 hours on a daylight saving change, so a day is
// never found by adding 24 hours to a midnight. Arithmetic on the day strings themselves (the
// next day, a week's Monday) lives in lib/analytics/range.ts and needs no zone.
//
// Pure, and safe in the browser: Intl knows the zone rules, so nothing is downloaded.

/** Until one is picked in Settings, days run midnight to midnight UTC. */
export const DEFAULT_TIME_ZONE = "UTC"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const cached = <T>(make: (timeZone: string) => T) => {
  const made = new Map<string, T>()
  return (timeZone: string): T => {
    let value = made.get(timeZone)
    if (value === undefined) made.set(timeZone, (value = make(timeZone)))
    return value
  }
}

const partsFormat = cached(
  (timeZone) =>
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }),
)

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** What a clock in the zone shows at an instant. */
function wallClock(ms: number, timeZone: string): WallClock {
  const out: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
  for (const part of partsFormat(timeZone).formatToParts(new Date(ms))) {
    if (part.type in out) out[part.type as keyof WallClock] = Number(part.value)
  }
  return out
}

/** How far the zone's clocks are ahead of UTC at an instant, in milliseconds (negative when behind). */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0")
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)

/** The calendar day an instant falls on in the zone. */
export function dayIn(instant: Date | number, timeZone: string): string {
  const ms = typeof instant === "number" ? instant : instant.getTime()
  if (timeZone === "UTC") return new Date(ms).toISOString().slice(0, 10)
  const w = wallClock(ms, timeZone)
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`
}

/** Today in the zone. */
export const todayIn = (timeZone: string, now: Date = new Date()): string => dayIn(now, timeZone)

/**
 * The first instant of a day in the zone. That is its midnight, except on the rare day whose
 * midnight a daylight saving change skips (the day then starts when the clocks jump) or repeats
 * (the first one).
 */
export function startOfDay(day: string, timeZone: string): Date {
  // The day's midnight read as if it were UTC. The real instant is that minus the zone's offset then.
  const wall = Date.parse(`${day}T00:00:00Z`)
  if (timeZone === "UTC") return new Date(wall)

  // Only an offset in force within a day either side can be the one, so try each of them and keep
  // the earliest instant whose clock really shows this midnight.
  const offsets = new Set([offsetAt(wall - 14 * HOUR_MS, timeZone), offsetAt(wall, timeZone), offsetAt(wall + 14 * HOUR_MS, timeZone)])
  let first: number | null = null
  for (const offset of offsets) {
    const t = wall - offset
    if (offsetAt(t, timeZone) === offset && (first === null || t < first)) first = t
  }
  if (first !== null) return new Date(first)

  // Midnight was skipped. Between the two candidates the clock goes from the day before to this
  // day, and the first instant on this day is where the day starts.
  let before = wall - Math.max(...offsets)
  let after = wall - Math.min(...offsets)
  while (after - before > 1) {
    const mid = Math.floor((before + after) / 2)
    if (dayIn(mid, timeZone) >= day) after = mid
    else before = mid
  }
  return new Date(after)
}

/** The first instant after a day: the start of the next one, which is not always 24 hours later. */
export const endOfDay = (day: string, timeZone: string): Date => startOfDay(nextDay(day), timeZone)

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/

/**
 * A time zone name the runtime knows, spelled the way it spells it ("asia/dhaka" is
 * "Asia/Dhaka", "Etc/UTC" is "UTC"), or null. Anything that is not an IANA-style name, such as
 * a bare offset, is refused.
 */
export function normalizeTimeZone(name: unknown): string | null {
  if (typeof name !== "string") return null
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 64 || !ZONE_NAME.test(trimmed)) return null
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone
    return resolved === "Etc/UTC" || resolved === "Etc/GMT" || resolved === "GMT" ? "UTC" : resolved
  } catch {
    return null
  }
}

/** Every zone the runtime knows, UTC first, for a picker. Intl's own list leaves UTC out. */
export function timeZoneNames(): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []
  return ["UTC", ...all.filter((zone) => zone !== "UTC")]
}

const offsetFormat = cached((timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }))

/** The zone's offset from UTC at an instant, the way a clock app writes it: "GMT+6", "GMT-4", "GMT+5:30". "UTC" for UTC. */
export function offsetLabel(timeZone: string, at: Date = new Date()): string {
  if (timeZone === "UTC") return "UTC"
  return offsetFormat(timeZone).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? timeZone
}

/** "Asia/Dhaka (GMT+6)", or just "UTC". */
export const describeTimeZone = (timeZone: string, at: Date = new Date()): string => (timeZone === "UTC" ? "UTC" : `${timeZone} (${offsetLabel(timeZone, at)})`)
