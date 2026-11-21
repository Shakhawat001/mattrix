// The login throttling rules, as pure functions of attempt history and the clock.
// lib/auth/rate-limit.ts keeps the history in Postgres; this file decides.
//
// Three keys are counted for every attempt: the address, the username, and everything
// together. The address limit and a high limit on everything together refuse outright;
// the username limit and a lower global one only narrow who may try. See judgeAttempt.

export type Attempt = { at: number; ok: boolean }

export const KEY_WINDOW_MS = 15 * 60_000
export const KEY_MAX_FAILURES = 5
export const GLOBAL_WINDOW_MS = 60 * 60_000
export const GLOBAL_MAX_FAILURES = 30
/** Past this many failures in the global window nobody may try, so even unlimited addresses buy a bounded number of guesses. */
export const GLOBAL_HARD_MAX_FAILURES = 100

/**
 * When the key may try again, or null if it may try now. Only failures since the
 * last success count, and only within the window: the key is locked once it has
 * `max` of them, until the oldest of the last `max` falls out of the window.
 */
export function lockedUntil(
  attempts: Attempt[],
  now: number,
  max = KEY_MAX_FAILURES,
  windowMs = KEY_WINDOW_MS,
): number | null {
  const lastSuccess = attempts.filter((a) => a.ok).reduce((latest, a) => Math.max(latest, a.at), 0)
  const failures = attempts
    .filter((a) => !a.ok && a.at > lastSuccess && a.at > now - windowMs)
    .sort((a, b) => a.at - b.at)
  if (failures.length < max) return null
  return failures[failures.length - max].at + windowMs
}

export function retryAfterSeconds(until: number | null, now: number): number {
  return until === null ? 0 : Math.max(1, Math.ceil((until - now) / 1000))
}

/** Failures since the key's last success, inside the window, oldest first. */
export function recentFailures(attempts: Attempt[], now: number, windowMs: number): number[] {
  const lastSuccess = attempts.filter((a) => a.ok).reduce((latest, a) => Math.max(latest, a.at), 0)
  return attempts
    .filter((a) => !a.ok && a.at > lastSuccess && a.at > now - windowMs)
    .map((a) => a.at)
    .sort((a, b) => a - b)
}

export type Verdict = { allowed: true } | { allowed: false; until: number }

/**
 * Decides one login attempt from the recent attempts on its three keys.
 *
 * The address limit is hard. The username limit and the lower global limit are not, because
 * anyone who knows the username could otherwise lock its owner out with a few wrong guesses.
 * When either is reached the account counts as under attack, and then each address gets one
 * try: its first. A guesser spread over many addresses gets one guess per address, and the
 * owner, trying from an address with no failures, still gets in.
 *
 * A second, much higher global limit is hard: past GLOBAL_HARD_MAX_FAILURES failures in the
 * global window nobody may try, the owner included, until the count falls. Without it a
 * guesser with enough addresses (a botnet, or blocks of IPv6) would have no limit at all.
 *
 * `includesCurrent`: the attempt being decided is already recorded as a failure (it is written
 * before the slow password check, so attempts sent at the same moment count against each other).
 */
export function judgeAttempt(
  history: { ip: Attempt[]; user: Attempt[]; global: Attempt[] },
  now: number,
  includesCurrent: boolean,
): Verdict {
  const extra = includesCurrent ? 1 : 0
  const ipLock = lockedUntil(history.ip, now, KEY_MAX_FAILURES + extra, KEY_WINDOW_MS)
  if (ipLock !== null) return { allowed: false, until: ipLock }
  const hardLock = lockedUntil(history.global, now, GLOBAL_HARD_MAX_FAILURES + extra, GLOBAL_WINDOW_MS)
  if (hardLock !== null) return { allowed: false, until: hardLock }

  const userLock = lockedUntil(history.user, now, KEY_MAX_FAILURES + extra, KEY_WINDOW_MS)
  const globalLock = lockedUntil(history.global, now, GLOBAL_MAX_FAILURES + extra, GLOBAL_WINDOW_MS)
  if (userLock === null && globalLock === null) return { allowed: true }

  // Under attack: only an address with no earlier failure may try.
  const earlier = recentFailures(history.ip, now, KEY_WINDOW_MS)
  const before = includesCurrent ? earlier.slice(0, -1) : earlier
  if (before.length === 0) return { allowed: true }
  // It may try again once its own failures have aged out, or once the attack has passed.
  const clean = before[before.length - 1] + KEY_WINDOW_MS
  const calm = Math.max(userLock ?? 0, globalLock ?? 0)
  return { allowed: false, until: Math.min(clean, calm) }
}
