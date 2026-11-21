import { getEnv } from "@/lib/env"

/**
 * Checks the whole environment the way the app does when it starts, and says what is wrong in
 * plain words. It never prints a secret. The Docker entrypoint runs it before the web server, so a
 * bad configuration stops the container at once with a readable list instead of failing on the
 * first request.
 */
export function checkEnvCommand(): number {
  try {
    const env = getEnv()
    console.log(
      `Configuration is valid: login "${env.user}" with a ${env.password.kind === "hash" ? "hashed" : "plain"} password, ` +
        (env.demoMode ? "demo mode (Shopify is never called)." : `Shopify is read every ${env.syncIntervalMinutes} minutes.`),
    )
    return 0
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    return 1
  }
}
