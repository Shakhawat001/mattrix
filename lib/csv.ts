// CSV for the exports. Two things matter: quoting, so a comma or a line break in a
// value cannot shift the columns, and formula injection. A spreadsheet runs a cell that
// starts with = + - @ (or a tab or carriage return) as a formula, and a shop name or a
// merchant's own words are text someone else wrote. Such a text cell is prefixed with an
// apostrophe, which makes the spreadsheet show it as plain text. Numbers are left alone.

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  if (typeof value === "boolean") return value ? "true" : "false"
  let text = value instanceof Date ? value.toISOString() : String(value)
  if (value instanceof Date === false && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"
}
