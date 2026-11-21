import { safeEqual } from "@/lib/crypto"
import { getEnv } from "@/lib/env"
import { hashPassword, verifyPassword } from "@/lib/auth/password"

// The one account lives in the environment. A plain DASHBOARD_PASSWORD is hashed in
// memory the first time it is needed, so every check goes through the same
// constant-time path as a stored hash.

let plainHash: Promise<string> | undefined

function configuredHash(): Promise<string> {
  const { password } = getEnv()
  if (password.kind === "hash") return Promise.resolve(password.hash)
  return (plainHash ??= hashPassword(password.value))
}

/**
 * The password check runs whatever the username, so a wrong username and a wrong
 * password take the same time and give the same answer.
 */
export async function checkCredentials(username: string, password: string): Promise<boolean> {
  const userMatches = safeEqual(username.trim().toLowerCase(), getEnv().user.toLowerCase())
  const passwordMatches = await verifyPassword(password, await configuredHash())
  return userMatches && passwordMatches
}

export function resetCredentialCache(): void {
  plainHash = undefined
}
