import { checkEnvCommand } from "./commands/check-env"
import { migrateCommand } from "./commands/migrate"
import { probeCommand } from "./commands/probe"
import { seedDemoCommand } from "./commands/seed-demo"
import { generateSecrets, hashPasswordCommand } from "./commands/secrets"

const USAGE = `Usage: cli <command>

  hash-password      Make the DASHBOARD_PASSWORD_HASH line for .env (asks for the password)
  generate-secrets   Make the SESSION_SECRET and ENCRYPTION_KEY lines for .env
  check-env          Check the environment and list anything wrong, without printing secrets
  migrate            Apply database migrations (needs DATABASE_URL)
  probe [days]       Try a Partner API token (needs PARTNER_ID and PARTNER_API_TOKEN)
  seed-demo          Fill the database with invented demo apps
`

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case "hash-password":
      return hashPasswordCommand()
    case "generate-secrets":
      console.log(generateSecrets().join("\n"))
      return 0
    case "check-env":
      return checkEnvCommand()
    case "migrate":
      return migrateCommand()
    case "probe":
      return probeCommand(args)
    case "seed-demo":
      return seedDemoCommand()
    default:
      console.error(USAGE)
      return command ? 1 : 0
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
