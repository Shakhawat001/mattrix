import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto"

// scrypt from Node's own crypto: a memory-hard password hash with no native
// dependency to compile in Docker. The cost parameters travel inside the hash, so
// they can be raised later without breaking hashes that already exist.

type Params = { N: number; r: number; p: number }

const DEFAULT: Params = { N: 2 ** 16, r: 8, p: 1 } // 64 MiB, in line with OWASP's scrypt guidance
const KEY_BYTES = 32
const MAX_MEMORY = 512 * 1024 * 1024
const MAX_PASSWORD_LENGTH = 1024

function derive(password: string, salt: Buffer, { N, r, p }: Params): Promise<Buffer> {
  const options: ScryptOptions = { N, r, p, maxmem: MAX_MEMORY }
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, options, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

/**
 * `scrypt:N:r:p:salt:hash`. Colons, not dollar signs: Docker Compose and Coolify read a
 * `$` in an env value as a variable and would quietly mangle the hash.
 */
export async function hashPassword(password: string, params: Params = DEFAULT): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, params)
  return `scrypt:${params.N}:${params.r}:${params.p}:${salt.toString("base64url")}:${key.toString("base64url")}`
}

/** False for a wrong password and for a hash that cannot be read; it never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false
  const [scheme, n, r, p, salt, hash] = stored.split(":")
  if (scheme !== "scrypt" || !salt || !hash) return false
  const params = { N: Number(n), r: Number(r), p: Number(p) }
  const sane =
    Number.isInteger(Math.log2(params.N)) && params.N >= 2 ** 12 && params.N <= 2 ** 18 &&
    params.r >= 1 && params.r <= 16 && params.p >= 1 && params.p <= 8
  if (!sane) return false
  try {
    const expected = Buffer.from(hash, "base64url")
    const actual = await derive(password, Buffer.from(salt, "base64url"), params)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
