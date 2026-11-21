import { describe, expect, it } from "vitest"
import { parseTimestamp, parseTimestampOrNull } from "@/lib/db/timestamps"

describe("timestamps from raw SQL", () => {
  it("reads the way Postgres writes them", () => {
    expect(parseTimestamp("2026-01-01 10:00:00+00").toISOString()).toBe("2026-01-01T10:00:00.000Z")
    expect(parseTimestamp("2026-01-01 10:00:00.123456+00").toISOString()).toBe("2026-01-01T10:00:00.123Z")
    expect(parseTimestamp("2026-01-01 10:00:00.5+00").toISOString()).toBe("2026-01-01T10:00:00.500Z")
  })
  it("honors an offset", () => {
    expect(parseTimestamp("2026-01-01 10:00:00+06").toISOString()).toBe("2026-01-01T04:00:00.000Z")
    expect(parseTimestamp("2026-01-01 10:00:00-05:30").toISOString()).toBe("2026-01-01T15:30:00.000Z")
    expect(parseTimestamp("2026-01-01 10:00:00+0530").toISOString()).toBe("2026-01-01T04:30:00.000Z")
  })
  it("reads ISO text, a missing zone as UTC, and passes a Date through", () => {
    expect(parseTimestamp("2026-01-01T10:00:00Z").toISOString()).toBe("2026-01-01T10:00:00.000Z")
    expect(parseTimestamp("2026-01-01 10:00:00").toISOString()).toBe("2026-01-01T10:00:00.000Z")
    const d = new Date("2026-01-01T10:00:00Z")
    expect(parseTimestamp(d)).toBe(d)
  })
  it("refuses what is not a timestamp, instead of returning an invalid Date", () => {
    for (const bad of ["", "yesterday", "2026-13-45 10:00:00+00", "2026-01-01"]) expect(() => parseTimestamp(bad), bad).toThrow()
  })
  it("keeps null as null", () => {
    expect(parseTimestampOrNull(null)).toBeNull()
    expect(parseTimestampOrNull("2026-01-01 10:00:00+00")?.getUTCHours()).toBe(10)
  })
})
