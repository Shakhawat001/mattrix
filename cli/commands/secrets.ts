import { randomBytes } from "node:crypto"
import { hashPassword } from "@/lib/auth/password"

/** Two lines for .env. URL-safe, so there is nothing to quote or escape. */
export function generateSecrets(): string[] {
  return [`SESSION_SECRET=${randomBytes(48).toString("base64url")}`, `ENCRYPTION_KEY=${randomBytes(32).toString("base64url")}`]
}

/** Reads a line from the terminal without echoing it, or the whole of stdin when piped. */
async function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process
  if (!stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "")
  }

  stdout.write(prompt)
  return new Promise((resolve) => {
    let value = ""
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off("data", onData)
          stdout.write("\n")
          return resolve(value)
        }
        if (ch === "\u0003") process.exit(130)
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on("data", onData)
  })
}

/** Prints the line to paste into .env. The password is read from the terminal, never from the command line. */
export async function hashPasswordCommand(): Promise<number> {
  const first = await readHidden("Password: ")
  if (first.length < 12) {
    console.error("Use at least 12 characters.")
    return 1
  }
  if (process.stdin.isTTY) {
    const second = await readHidden("Again: ")
    if (second !== first) {
      console.error("The two passwords do not match.")
      return 1
    }
  }
  console.log(`DASHBOARD_PASSWORD_HASH=${await hashPassword(first)}`)
  return 0
}
