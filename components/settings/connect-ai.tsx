"use client"

import { toast } from "sonner"
import { useNewToken } from "@/components/settings/api-tokens"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { claudeCodeCommand, claudeDesktopConfig, codexConfig, connectTarget, curlTest, cursorConfig, openCodeConfig, TOKEN_PLACEHOLDER } from "@/lib/mcp/connect"
import { cn } from "@/lib/utils"

const QUESTIONS = [
  "How did MRR change in the last 30 days, and which shops were behind it?",
  "Which subscriptions are set to cancel, and how much MRR do they take with them?",
  "Why did shops uninstall last month? Quote what they wrote.",
  "Which trials end this week, and what would they add to MRR?",
  "Compare installs and uninstalls this month with last month, for each app.",
]

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success("Copied.")
  } catch {
    toast.error("The browser did not allow copying. Select the text and copy it yourself.")
  }
}

/** A command or a file to paste, with a button that copies it. */
function Snippet({ text, label, wrap = false }: { text: string; label: string; wrap?: boolean }) {
  return (
    <div className="relative">
      <pre className={cn("bg-muted py-3 pr-20 pl-3 font-mono text-xs leading-relaxed", wrap ? "break-all whitespace-pre-wrap" : "overflow-x-auto")}>{text}</pre>
      <Button type="button" size="xs" variant="outline" className="absolute top-2 right-2 bg-background" aria-label={`Copy ${label}`} onClick={() => copy(text)}>
        Copy
      </Button>
    </div>
  )
}

const Code = ({ children }: { children: React.ReactNode }) => <code className="bg-muted px-1 py-0.5 font-mono text-xs wrap-break-word">{children}</code>

const Steps = ({ children }: { children: React.ReactNode }) => <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm leading-relaxed marker:text-muted-foreground">{children}</ol>

const Step = ({ children }: { children: React.ReactNode }) => (
  <li className="pl-1">
    <div className="flex flex-col gap-2">{children}</div>
  </li>
)

const CLIENTS = [
  { value: "claude-code", label: "Claude Code" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "cursor", label: "Cursor" },
  { value: "opencode", label: "OpenCode" },
  { value: "codex", label: "Codex" },
  { value: "curl", label: "Test with curl" },
]

/**
 * The Connect an AI part of Settings: each AI app's setup, with the endpoint and, right after a
 * token is created, that token filled in. Until then a placeholder stands for the token.
 */
export function ConnectAi({ endpoint }: { endpoint: string | null }) {
  const { created } = useNewToken()
  const target = connectTarget(endpoint, created?.token ?? null)

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">Connect an AI</CardTitle>
        <CardDescription className="text-xs">
          {created
            ? `The steps below have the token for ${created.name} filled in. Copy what you need before you click Done: the token is not shown again.`
            : `Let Claude, Cursor or another AI app read these numbers. Create a token above first, and the steps here have it filled in. Or put a token you saved in place of ${TOKEN_PLACEHOLDER}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <span className="text-xs tracking-wider text-muted-foreground uppercase">Endpoint</span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-sm wrap-anywhere">{target.url}</code>
            <Button type="button" size="xs" variant="outline" aria-label="Copy the endpoint" onClick={() => copy(target.url)}>
              Copy
            </Button>
          </div>
          {endpoint === null ? <p className="text-xs text-muted-foreground">Put the address you open this dashboard at in place of YOUR-DASHBOARD-ADDRESS.</p> : null}
        </div>

        <Tabs defaultValue="claude-code">
          <TabsList variant="line" className="max-w-full justify-start overflow-x-auto">
            {CLIENTS.map((c) => (
              <TabsTrigger key={c.value} value={c.value} className="flex-none">
                {c.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="claude-code" className="pt-3">
            <Steps>
              <Step>
                <p>In a terminal, run this command. It adds AppMetrics to Claude Code for every folder you work in.</p>
                <Snippet text={claudeCodeCommand(target)} label="the Claude Code command" wrap />
              </Step>
              <Step>
                <p>
                  Run <Code>claude mcp list</Code>, or type <Code>/mcp</Code> in Claude Code, and check that appmetrics shows as connected.
                </p>
              </Step>
            </Steps>
          </TabsContent>

          <TabsContent value="claude-desktop" className="pt-3">
            <Steps>
              <Step>
                <p>
                  Install Node.js (the LTS version) from nodejs.org if you do not have it. Claude Desktop&apos;s Connectors screen cannot send a token, so Claude Desktop reaches AppMetrics through mcp-remote, a small bridge that
                  runs on Node.js.
                </p>
              </Step>
              <Step>
                <p>
                  In Claude Desktop, open Settings, then Developer, and click Edit Config. It opens <Code>claude_desktop_config.json</Code>, which is in <Code>~/Library/Application Support/Claude</Code> on macOS and in{" "}
                  <Code>%APPDATA%\Claude</Code> on Windows.
                </p>
              </Step>
              <Step>
                <p>Paste this into the file and save it. If the file already lists servers under &quot;mcpServers&quot;, add the &quot;appmetrics&quot; entry next to them instead.</p>
                <Snippet text={claudeDesktopConfig(target)} label="the Claude Desktop config" />
              </Step>
              <Step>
                <p>
                  Quit Claude Desktop and open it again: closing the window is not enough. On macOS, choose Claude, then Quit Claude, in the menu bar. On Windows, right-click the Claude icon in the system tray and choose Quit.
                </p>
              </Step>
              <Step>
                <p>Click + in the message box, then Connectors: appmetrics should be listed with its tools. If it is not, Settings, then Developer, shows the error.</p>
              </Step>
            </Steps>
          </TabsContent>

          <TabsContent value="cursor" className="pt-3">
            <Steps>
              <Step>
                <p>
                  Open <Code>~/.cursor/mcp.json</Code> (on Windows, <Code>%USERPROFILE%\.cursor\mcp.json</Code>), or create it if it is missing. Paste this and save. If the file already lists servers under
                  &quot;mcpServers&quot;, add the &quot;appmetrics&quot; entry next to them instead.
                </p>
                <Snippet text={cursorConfig(target)} label="the Cursor config" />
              </Step>
              <Step>
                <p>Cursor picks the change up by itself. Check under Customize in the sidebar that appmetrics is on and lists its tools. Errors are in the Output panel, under MCP Logs.</p>
              </Step>
            </Steps>
          </TabsContent>

          <TabsContent value="opencode" className="pt-3">
            <Steps>
              <Step>
                <p>
                  Open <Code>~/.config/opencode/opencode.json</Code>, or create it if it is missing. Paste this and save. If the file already has settings, add the &quot;mcp&quot; part next to them.
                </p>
                <Snippet text={openCodeConfig(target)} label="the OpenCode config" />
              </Step>
              <Step>
                <p>
                  OpenCode reloads its config by itself. Run <Code>opencode mcp list</Code> and check that appmetrics shows as connected.
                </p>
              </Step>
            </Steps>
          </TabsContent>

          <TabsContent value="codex" className="pt-3">
            <Steps>
              <Step>
                <p>
                  Open <Code>~/.codex/config.toml</Code> (on Windows, <Code>%USERPROFILE%\.codex\config.toml</Code>), or create it if it is missing, and add these lines at the end. The Codex CLI, its IDE extension and the
                  ChatGPT desktop app all read this file.
                </p>
                <Snippet text={codexConfig(target)} label="the Codex config" />
              </Step>
              <Step>
                <p>
                  Run <Code>codex mcp list</Code>, or type <Code>/mcp</Code> in a session, and check that appmetrics is connected.
                </p>
              </Step>
            </Steps>
          </TabsContent>

          <TabsContent value="curl" className="pt-3">
            <Steps>
              <Step>
                <p>To check the endpoint and the token without an AI app, paste this into a terminal on macOS or Linux. It asks for your apps, the way an AI app does.</p>
                <Snippet text={curlTest(target)} label="the curl command" />
              </Step>
              <Step>
                <p>
                  It works when the answer ends in a <Code>data:</Code> line with your apps&apos; names. 401 means the token is missing, mistyped, revoked or expired. 429 means too many requests: wait a minute.
                </p>
              </Step>
            </Steps>
          </TabsContent>
        </Tabs>

        <div className="flex flex-col gap-2">
          <h3 className="text-xs tracking-wider text-muted-foreground uppercase">Try asking</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed marker:text-muted-foreground">
            {QUESTIONS.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Or start a ready-made request: weekly_review, investigate_churn and at_risk_followup. In Claude Code and OpenCode, type <Code>/appmetrics:</Code> to pick one, and add an app or a range after investigate_churn:{" "}
            <Code>/appmetrics:investigate_churn show last_30_days</Code>. In Claude Desktop, they are under + in the message box.
          </p>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Each setup saves the token in that app&apos;s settings on your computer: revoke it above if the computer is lost or shared. What the AI reads goes to its provider, and Shopify&apos;s API terms forbid using it to train AI, so
          connect an account that does not train on your data. docs/MCP.md has the details.
        </p>
      </CardContent>
    </Card>
  )
}
