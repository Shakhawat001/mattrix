import { decryptSecret, encryptSecret } from "@/lib/crypto"
import { getEnv } from "@/lib/env"

// Partner API tokens are stored encrypted and are never sent to the browser. Only
// the last four characters are kept in the clear, so a connection can be told apart.

export function encryptToken(token: string): { ciphertext: string; hint: string } {
  return { ciphertext: encryptSecret(token, getEnv().encryptionKey), hint: token.slice(-4) }
}

export function decryptToken(ciphertext: string): string {
  return decryptSecret(ciphertext, getEnv().encryptionKey)
}
