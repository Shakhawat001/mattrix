// Every tool the MCP endpoint serves. A new tool is one file in this folder (the contract is in
// lib/mcp/tool.ts) and one line here; lib/mcp/server.ts registers them all.

export { explainMrrChangeTool } from "./explain-mrr-change"
export { getAtRiskTool } from "./get-at-risk"
export { getChurnTool } from "./get-churn"
export { getDataHealthTool } from "./get-data-health"
export { getDefinitionsTool } from "./get-definitions"
export { getMetricsTool } from "./get-metrics"
export { getRetentionTool } from "./get-retention"
export { getShopTimelineTool } from "./get-shop-timeline"
export { getTimeseriesTool } from "./get-timeseries"
export { getTrialsTool } from "./get-trials"
export { listAppsTool } from "./list-apps"
export { listShopsTool } from "./list-shops"
