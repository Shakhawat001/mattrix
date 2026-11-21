// One JSON object per line on stdout (stderr for warnings and errors), which is what
// Docker, Coolify and every log shipper expect. Callers never pass tokens or passwords:
// the Partner client already strips its token from every error it raises.

type Level = "debug" | "info" | "warn" | "error"

function write(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout
  stream.write(line + "\n")
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
}
