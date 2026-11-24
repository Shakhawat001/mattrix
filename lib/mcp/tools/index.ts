// Every tool the MCP endpoint serves. A new tool is one file in this folder (the contract is in
// lib/mcp/tool.ts) and one line here; lib/mcp/server.ts registers them all.

export { getDefinitionsTool } from "./get-definitions"
export { listAppsTool } from "./list-apps"
