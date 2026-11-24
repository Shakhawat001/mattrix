import { describe, expect, it } from "vitest"
import { ALL_APPS, annotationInput, lastAnnotationDate } from "@/lib/analytics/annotations"

const APP = "0b6f7c55-3c1e-4c55-9a4f-2f1d3b8e6a10"
const TODAY = "2026-11-24"
const schema = annotationInput([APP], TODAY)

const form = (over: Record<string, unknown> = {}) => ({ date: "2026-03-01", appId: ALL_APPS, label: "Price up to $19", note: "", ...over })
const ok = (over: Record<string, unknown> = {}) => {
  const result = schema.safeParse(form(over))
  if (!result.success) throw new Error(`rejected: ${result.error.issues.map((i) => i.message).join(" ")}`)
  return result.data
}
const errors = (over: Record<string, unknown>) => {
  const result = schema.safeParse(form(over))
  return result.success ? [] : result.error.issues.map((i) => i.message)
}

describe("annotation input", () => {
  it("takes a full form", () => {
    expect(ok({ appId: APP, note: "Every plan up by $5" })).toEqual({ date: "2026-03-01", appId: APP, label: "Price up to $19", note: "Every plan up by $5" })
  })

  it("reads All apps as no app", () => {
    expect(ok()).toMatchObject({ appId: null })
  })

  it("takes a real day from 2012 to a year from today", () => {
    expect(ok({ date: "2012-01-01" }).date).toBe("2012-01-01")
    expect(ok({ date: TODAY }).date).toBe(TODAY)
    // A planned launch, marked ahead of time.
    expect(ok({ date: "2027-11-24" }).date).toBe("2027-11-24")

    const outside = ["Pick a real date between Jan 1, 2012 and Nov 24, 2027."]
    expect(errors({ date: "2011-12-31" })).toEqual(outside)
    expect(errors({ date: "2027-11-25" })).toEqual(outside)
    for (const date of ["2026-02-30", "2026-13-01", "2026-3-1", "01/03/2026", "2026-03-01T00:00:00Z", ""]) expect(errors({ date })).toEqual(outside)
    expect(errors({ date: null })).toEqual(["Pick a date."])
  })

  it("ends a year from today on the same day, or on March 1 from a February 29", () => {
    expect(lastAnnotationDate("2026-11-24")).toBe("2027-11-24")
    expect(lastAnnotationDate("2026-12-31")).toBe("2027-12-31")
    expect(lastAnnotationDate("2028-02-29")).toBe("2029-03-01")
  })

  it("takes only an app that exists, or All apps", () => {
    const unknown = ["Unknown app. Reload the page and pick again."]
    expect(errors({ appId: "6a1e1f0c-55d4-4a43-8d3f-0d5f3f0e9b21" })).toEqual(unknown)
    expect(errors({ appId: "" })).toEqual(unknown)
    expect(errors({ appId: "every" })).toEqual(unknown)
    expect(errors({ appId: null })).toEqual(["Pick an app, or All apps."])
    // With no apps yet, All apps still works.
    expect(annotationInput([], TODAY).safeParse(form()).success).toBe(true)
  })

  it("wants a label of at most 60 characters, on one line", () => {
    expect(ok({ label: "x".repeat(60) }).label).toHaveLength(60)
    expect(errors({ label: "x".repeat(61) })).toEqual(["Keep the label to 60 characters."])
    expect(errors({ label: "" })).toEqual(["Write a short label."])
    expect(errors({ label: " \n\t " })).toEqual(["Write a short label."])
    expect(errors({ label: null })).toEqual(["Write a short label."])
    // Spaces and line breaks fold into single spaces before the count.
    expect(ok({ label: "  New \r\n onboarding\t flow  " }).label).toBe("New onboarding flow")
    expect(ok({ label: `${"x".repeat(30)}${" ".repeat(10)}${"y".repeat(29)}` }).label).toHaveLength(60)
  })

  it("leaves the note out when it is empty", () => {
    expect(ok({ note: "" }).note).toBeNull()
    expect(ok({ note: "   \n " }).note).toBeNull()
    expect(ok({ note: null }).note).toBeNull()
    expect(ok({ note: undefined }).note).toBeNull()
  })

  it("keeps the note's line breaks and counts each as one character, as the browser does", () => {
    expect(ok({ note: " First line\r\nsecond line\twith a tab \n" }).note).toBe("First line\nsecond line\twith a tab")
    expect(ok({ note: "x".repeat(500) }).note).toHaveLength(500)
    expect(errors({ note: "x".repeat(501) })).toEqual(["Keep the note to 500 characters."])
    // 501 characters as sent, 500 once the line break is one character.
    expect(ok({ note: `${"x".repeat(498)}\r\ny` }).note).toHaveLength(500)
  })

  it("refuses control characters, which Postgres or a chart would choke on", () => {
    expect(errors({ label: "Launch\u0000" })).toEqual(["Use plain text in the label."])
    expect(errors({ label: "Launch\u001b[31m" })).toEqual(["Use plain text in the label."])
    expect(errors({ note: "Bell\u0007" })).toEqual(["Use plain text in the note."])
    expect(errors({ note: "Null\u0000" })).toEqual(["Use plain text in the note."])
  })

  it("names the first problem first, in the order of the form", () => {
    expect(errors({ date: "2030-01-01", appId: "nope", label: "", note: "x".repeat(501) })).toEqual([
      "Pick a real date between Jan 1, 2012 and Nov 24, 2027.",
      "Unknown app. Reload the page and pick again.",
      "Write a short label.",
      "Keep the note to 500 characters.",
    ])
  })
})
