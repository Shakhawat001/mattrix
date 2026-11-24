import type { z } from "zod"
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
  /** Validated by the SDK before run is called. A tool with no input takes z.object({}). */
  input: Input
  /** Reads only through ctx.read() and returns envelope(...) from lib/mcp/output.ts. */
  run(ctx: McpContext, input: z.infer<Input>): Promise<Envelope<unknown>>
}

export const defineTool = <Input extends z.ZodObject>(tool: McpTool<Input>): McpTool<Input> => tool

/** A problem the agent can fix, such as an unknown app id. Its message reaches the agent as written. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolError"
  }
}
