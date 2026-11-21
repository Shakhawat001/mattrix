// Drizzle turns off the driver's own date parsing, because it converts values itself for the
// columns it knows about. A query written in raw SQL has no such columns, so a timestamp comes
// back as Postgres writes it: "2026-01-01 10:00:00.123+00". This reads that, or a Date, into a Date.

const POSTGRES_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/

export function parseTimestamp(value: string | Date): Date {
  if (value instanceof Date) return value
  const match = POSTGRES_TIMESTAMP.exec(value.trim())
  if (!match) throw new Error(`Not a timestamp: ${value}`)
  const [, day, time, zone] = match
  // No zone means the value was already in UTC (every column here is timestamptz and the session is UTC).
  let offset = "Z"
  if (zone && zone !== "Z") {
    const digits = zone.replace(":", "")
    offset = `${digits.slice(0, 3)}:${digits.slice(3) || "00"}`
  }
  const date = new Date(`${day}T${time}${offset}`)
  if (Number.isNaN(date.getTime())) throw new Error(`Not a timestamp: ${value}`)
  return date
}

export const parseTimestampOrNull = (value: string | Date | null): Date | null => (value === null ? null : parseTimestamp(value))
