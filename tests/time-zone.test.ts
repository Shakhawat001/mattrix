import { fileURLToPath } from "node:url"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { describe, expect, it } from "vitest"
import { awaitingRebuild } from "@/lib/analytics/queries"
import { addDays } from "@/lib/analytics/range"
import { formatDateTime } from "@/lib/format"
import { dayIn, describeTimeZone, endOfDay, normalizeTimeZone, offsetLabel, startOfDay, timeZoneNames, todayIn } from "@/lib/time-zone"

const HOUR = 3_600_000

// Zones chosen for what tends to break day math: no offset, a whole-hour one ahead of UTC (the
// dashboard's first real user), a half-hour one, a 45-minute one, the furthest ahead and behind,
// northern and southern daylight saving, a half-hour daylight saving change, and three zones
// whose daylight saving change lands on midnight itself, skipping it or showing it twice.
const ZONES = [
  "UTC",
  "Asia/Dhaka",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Pacific/Chatham",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
  "America/New_York",
  "Europe/London",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "America/Santiago",
  "Asia/Beirut",
  "America/Havana",
]

function everyDay(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

const DAYS = everyDay("2024-01-01", "2027-12-31")

describe("days and instants agree in every zone", () => {
  for (const zone of ZONES) {
    it(`${zone}: each day starts on itself, right after the day before ends, and lasts 23 to 25 hours`, () => {
      for (const day of DAYS) {
        const start = startOfDay(day, zone).getTime()
        const end = endOfDay(day, zone).getTime()
        expect(dayIn(start, zone), `${day} starts on itself`).toBe(day)
        expect(dayIn(start - 1, zone), `the instant before ${day} is the day before`).toBe(addDays(day, -1))
        expect(dayIn(end - 1, zone), `the last instant of ${day} is on it`).toBe(day)
        expect(end).toBe(startOfDay(addDays(day, 1), zone).getTime())
        const hours = (end - start) / HOUR
        expect(hours, `${day} is ${hours} hours`).toBeGreaterThanOrEqual(23)
        expect(hours, `${day} is ${hours} hours`).toBeLessThanOrEqual(25)
      }
    })
  }

  it("puts every instant inside the day it reads as, all year, at every hour", () => {
    for (const zone of ZONES) {
      for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 7 * HOUR + 13 * 60_000) {
        const day = dayIn(t, zone)
        expect(startOfDay(day, zone).getTime(), `${zone} ${new Date(t).toISOString()}`).toBeLessThanOrEqual(t)
        expect(endOfDay(day, zone).getTime(), `${zone} ${new Date(t).toISOString()}`).toBeGreaterThan(t)
      }
    }
  })
})

describe("startOfDay", () => {
  it("is plain midnight UTC for UTC", () => {
    expect(startOfDay("2026-11-27", "UTC").toISOString()).toBe("2026-11-27T00:00:00.000Z")
    expect(endOfDay("2026-12-31", "UTC").toISOString()).toBe("2027-01-01T00:00:00.000Z")
  })

  it("is local midnight in a zone ahead of UTC", () => {
    expect(startOfDay("2026-11-27", "Asia/Dhaka").toISOString()).toBe("2026-11-26T18:00:00.000Z")
    expect(startOfDay("2026-11-27", "Asia/Kolkata").toISOString()).toBe("2026-11-26T18:30:00.000Z")
  })

  it("is local midnight in a zone behind UTC, on either side of a daylight saving change", () => {
    expect(startOfDay("2026-03-07", "America/New_York").toISOString()).toBe("2026-03-07T05:00:00.000Z")
    expect(startOfDay("2026-03-09", "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z")
  })

  it("makes the day of a change 23 or 25 hours long", () => {
    const hours = (day: string, zone: string) => (endOfDay(day, zone).getTime() - startOfDay(day, zone).getTime()) / HOUR
    expect(hours("2026-03-08", "America/New_York")).toBe(23)
    expect(hours("2026-11-01", "America/New_York")).toBe(25)
    expect(hours("2026-04-05", "Australia/Sydney")).toBe(25)
    expect(hours("2026-04-05", "Australia/Lord_Howe")).toBe(24.5)
  })

  it("starts a day whose midnight is skipped when the clocks jump", () => {
    // Santiago, 6 Sep 2026: 23:59:59 on the 5th is followed by 01:00 on the 6th.
    expect(startOfDay("2026-09-06", "America/Santiago").toISOString()).toBe("2026-09-06T04:00:00.000Z")
    // Beirut, 29 Mar 2026, the same at UTC+2.
    expect(startOfDay("2026-03-29", "Asia/Beirut").toISOString()).toBe("2026-03-28T22:00:00.000Z")
  })

  it("starts a day whose midnight happens twice at the first one", () => {
    // Havana, 1 Nov 2026: 00:59:59 is followed by 00:00 again, an hour later.
    expect(startOfDay("2026-11-01", "America/Havana").toISOString()).toBe("2026-11-01T04:00:00.000Z")
    expect((endOfDay("2026-11-01", "America/Havana").getTime() - startOfDay("2026-11-01", "America/Havana").getTime()) / HOUR).toBe(25)
  })
})

describe("dayIn and todayIn", () => {
  it("reads the calendar day in the zone, not in UTC", () => {
    const evening = new Date("2026-11-26T19:30:00Z") // 01:30 on the 27th in Dhaka, 14:30 on the 26th in New York
    expect(dayIn(evening, "UTC")).toBe("2026-11-26")
    expect(dayIn(evening, "Asia/Dhaka")).toBe("2026-11-27")
    expect(dayIn(evening, "America/New_York")).toBe("2026-11-26")
    expect(dayIn(new Date("2026-11-27T03:00:00Z"), "America/New_York")).toBe("2026-11-26")
    expect(todayIn("Asia/Dhaka", evening)).toBe("2026-11-27")
  })
})

describe("normalizeTimeZone", () => {
  it("accepts zone names in the runtime's own spelling", () => {
    expect(normalizeTimeZone("Asia/Dhaka")).toBe("Asia/Dhaka")
    expect(normalizeTimeZone(" asia/dhaka ")).toBe("Asia/Dhaka")
    // A three-part name is accepted. ICU may spell it shorter (America/Buenos_Aires); either is the same zone.
    expect(normalizeTimeZone("America/Argentina/Buenos_Aires")).toMatch(/Buenos_Aires$/)
  })

  it("spells every name for UTC as UTC", () => {
    for (const name of ["UTC", "utc", "Etc/UTC", "Etc/GMT"]) expect(normalizeTimeZone(name), name).toBe("UTC")
  })

  it("accepts both spellings of a renamed zone", () => {
    expect(normalizeTimeZone("Asia/Kolkata")).not.toBeNull()
    expect(normalizeTimeZone("Asia/Calcutta")).not.toBeNull()
  })

  it("refuses unknown zones, bare offsets and junk", () => {
    for (const bad of ["Nope/Zone", "+06:00", "GMT+6", "", "   ", "Asia/Dhaka; drop table", "a".repeat(65), null, undefined, 6]) expect(normalizeTimeZone(bad), String(bad)).toBeNull()
  })
})

describe("names and labels", () => {
  it("lists UTC first, once, and every zone it lists is accepted", () => {
    const names = timeZoneNames()
    expect(names[0]).toBe("UTC")
    expect(names.filter((n) => n === "UTC")).toHaveLength(1)
    expect(names).toContain("Asia/Dhaka")
    for (const name of names) expect(normalizeTimeZone(name), name).not.toBeNull()
  })

  it("writes offsets the way a clock app does", () => {
    const winter = new Date("2026-01-15T12:00:00Z")
    expect(offsetLabel("UTC", winter)).toBe("UTC")
    expect(offsetLabel("Asia/Dhaka", winter)).toBe("GMT+6")
    expect(offsetLabel("Asia/Kolkata", winter)).toBe("GMT+5:30")
    expect(offsetLabel("America/New_York", winter)).toBe("GMT-5")
    expect(offsetLabel("America/New_York", new Date("2026-07-15T12:00:00Z"))).toBe("GMT-4")
    expect(describeTimeZone("Asia/Dhaka", winter)).toBe("Asia/Dhaka (GMT+6)")
    expect(describeTimeZone("UTC", winter)).toBe("UTC")
  })
})

describe("formatDateTime", () => {
  const moment = new Date("2026-11-27T14:03:00Z")

  it("writes a moment on the zone's clock, with the zone after it", () => {
    expect(formatDateTime(moment, "UTC")).toBe("Nov 27, 2026, 14:03 UTC")
    expect(formatDateTime(moment, "Asia/Dhaka")).toBe("Nov 27, 2026, 20:03 GMT+6")
    expect(formatDateTime(moment, "Asia/Kolkata")).toBe("Nov 27, 2026, 19:33 GMT+5:30")
    expect(formatDateTime(moment, "America/New_York")).toBe("Nov 27, 2026, 09:03 EST")
  })

  it("writes the date of the zone, which can differ from the UTC date", () => {
    expect(formatDateTime(new Date("2026-11-26T19:30:00Z"), "Asia/Dhaka")).toBe("Nov 27, 2026, 01:30 GMT+6")
    expect(formatDateTime(new Date("2026-11-27T00:05:00Z"), "Asia/Dhaka")).toBe("Nov 27, 2026, 06:05 GMT+6")
    expect(formatDateTime(new Date("2026-11-26T18:00:00Z"), "Asia/Dhaka")).toBe("Nov 27, 2026, 00:00 GMT+6")
  })
})

describe("awaitingRebuild", () => {
  const built = (derivedTimeZone: string | null) => ({ derivedAt: new Date("2026-11-27T00:00:00Z"), derivedTimeZone })

  it("is true only while an app built in another zone is waiting for the worker", () => {
    expect(awaitingRebuild([built("UTC"), built("UTC")], "UTC")).toBe(false)
    expect(awaitingRebuild([built("UTC"), built("Asia/Dhaka")], "Asia/Dhaka")).toBe(true)
    expect(awaitingRebuild([built("Asia/Dhaka")], "Asia/Dhaka")).toBe(false)
    expect(awaitingRebuild([built(null)], "UTC")).toBe(true)
  })

  it("ignores apps never built, which have nothing to mix up", () => {
    expect(awaitingRebuild([{ derivedAt: null, derivedTimeZone: null }], "Asia/Dhaka")).toBe(false)
    expect(awaitingRebuild([], "Asia/Dhaka")).toBe(false)
  })
})

describe("the time zone migration", () => {
  it("splits into the three statements it was written as, and stamps old builds as UTC", () => {
    const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) })
    const mine = migrations.find((m) => m.sql[0].trim().startsWith('CREATE TABLE "settings"'))
    expect(mine).toBeDefined()
    const [create, column, stamp] = mine!.sql.map((statement) => statement.trim())
    expect(mine!.sql).toHaveLength(3)
    expect(create).toMatch(/^CREATE TABLE "settings"/)
    expect(column).toBe('ALTER TABLE "apps" ADD COLUMN "derived_time_zone" text;')
    expect(stamp).toMatch(/UPDATE "apps" SET "derived_time_zone" = 'UTC' WHERE "derived_at" IS NOT NULL;$/)
  })
})
