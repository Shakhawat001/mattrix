import { z } from "zod"
import { CONVENTION_TEXT, METRIC_DEFINITIONS, METRIC_IDS } from "../definitions"
import { envelope, OUTPUT_RULES } from "../output"
import { defineTool, ToolError } from "../tool"

export const getDefinitionsTool = defineTool({
  name: "get_definitions",
  title: "Metric definitions",
  description: [
    "What every number means, from the same registry the dashboard's tooltips read.",
    "Without an id: the conventions every number follows (days are UTC; how trials, plan changes, cancels, reinstalls and refunds count; why a rate can be null), how the tools write numbers, and every metric with its id, label, unit, which direction is better, and its definition.",
    "With an id: that one metric.",
    "Read it before you explain a number to the user, and quote the definition instead of guessing what a metric means.",
  ].join(" "),
  input: z.object({
    id: z.enum(METRIC_IDS).optional().describe("One metric's id, such as mrr or subChurnRate. Leave it out for the conventions and every metric."),
  }),
  async run(_ctx, { id }) {
    if (id === undefined) return envelope({ conventions: CONVENTION_TEXT, answer_format: OUTPUT_RULES, metrics: METRIC_DEFINITIONS })
    const metric = METRIC_DEFINITIONS.find((m) => m.id === id)
    if (!metric) throw new ToolError(`No metric has the id ${id}. Call get_definitions without an id for the list.`)
    return envelope({ metric })
  },
})
