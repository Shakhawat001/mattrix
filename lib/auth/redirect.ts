/**
 * Where to go after logging in. Only a path on this site is accepted: one leading
 * slash, no scheme, no backslash (browsers read "/\evil.com" as "//evil.com"), no
 * control characters. Anything else, including a loop back to /login, goes home.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value) return "/"
  if (!value.startsWith("/") || value.startsWith("//")) return "/"
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/"
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login/")) return "/"
  return value
}

/** "about 14 minutes", for the lockout message. */
export function describeWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`
  const minutes = Math.ceil(seconds / 60)
  return minutes === 1 ? "1 minute" : `${minutes} minutes`
}
