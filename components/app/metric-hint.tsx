"use client"

import { InfoIcon } from "@phosphor-icons/react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** An (i) that explains a number in plain words. Reachable by keyboard, not only by hover. */
export function MetricHint({ text, label = "What this means" }: { text: string; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" aria-label={label} className="text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground" />}>
        <InfoIcon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-64 leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  )
}
