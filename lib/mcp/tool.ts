import { z } from "zod"
import type { McpContext } from "./context"
import type { Envelope } from "./output"

// What a tool is. lib/mcp/server.ts registers every tool in lib/mcp/tools/index.ts with the same
// read-only annotations, runs it with the request's context, and turns what it returns (or
// throws) into the answer the agent reads.

export type McpTool<Input extends z.ZodObject = z.ZodObject> = {
  /** snake_case: list_apps, get_metrics. */
  name: string
  title: string
  /** Written for an AI reader: what the tool returns, when to call it, and its caveats. */
  description: string
  /** Validated by the SDK before run is called, refusing any other field (strictInput). A tool with no input takes z.object({}). */
  input: Input
  /** Reads only through ctx.read() and returns envelope(...) from lib/mcp/output.ts. */
  run(ctx: McpContext, input: z.infer<Input>): Promise<Envelope<unknown>>
}

export const defineTool = <Input extends z.ZodObject>(tool: McpTool<Input>): McpTool<Input> => tool

const listed = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join(""))

/**
 * The schema the SDK checks a tool's arguments against: its input, refusing any field it does not
 * take. Zod drops such a field without a word, so an agent that wrote range for preset got the
 * default range and never knew. The error names the field and lists the tool's own.
 */
export function strictInput(tool: Pick<McpTool, "name" | "input">): z.ZodObject {
  const fields = Object.keys(tool.input.shape)
  const takes = fields.length === 0 ? `${tool.name} takes no arguments.` : `${tool.name} takes ${listed(fields)}.`
  return z.strictObject(tool.input.shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys" ? `Unknown ${issue.keys.length === 1 ? "argument" : "arguments"} ${listed(issue.keys.map((key) => JSON.stringify(key)))}. ${takes}` : undefined,
  })
}

/** A problem the agent can fix, such as an unknown app id. Its message reaches the agent as written. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolError"
  }
}
