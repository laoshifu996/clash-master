"use client";

import { ChevronRight, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ProxyChainBadgeProps {
  chains?: string[] | null;
  truncateLabel?: boolean;
  wrapperClassName?: string;
  badgeClassName?: string;
  countClassName?: string;
  emptyClassName?: string;
}

function ChainFlow({ chain }: { chain: string }) {
  const segments = chain
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean);

  // Backend stores full chain as "proxy > ... > rule", display as "rule > ... > proxy".
  const displaySegments = segments.length > 1 ? [...segments].reverse() : segments;

  const getNodeTone = (idx: number, total: number) => {
    if (idx === 0) {
      return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-200 dark:border-violet-400/35 dark:bg-violet-500/20";
    }
    if (idx === total - 1) {
      return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200 dark:border-emerald-400/40 dark:bg-emerald-500/20";
    }
    return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-200 dark:border-blue-400/35 dark:bg-blue-500/20";
  };

  const getLinkTone = (idx: number, total: number) => {
    if (idx === 0) {
      return {
        line: "bg-gradient-to-r from-violet-400/80 to-blue-400/80 dark:from-violet-300/80 dark:to-blue-300/80",
        dot: "bg-blue-500/80 dark:bg-blue-300/90",
      };
    }
    if (idx === total - 2) {
      return {
        line: "bg-gradient-to-r from-blue-400/80 to-emerald-400/80 dark:from-blue-300/80 dark:to-emerald-300/80",
        dot: "bg-emerald-500/80 dark:bg-emerald-300/90",
      };
    }
    return {
      line: "bg-gradient-to-r from-blue-400/80 to-blue-300/80 dark:from-blue-300/80 dark:to-blue-200/80",
      dot: "bg-blue-500/80 dark:bg-blue-300/90",
    };
  };

  return (
    <div className="overflow-x-auto pb-0.5">
      <div className="inline-flex items-center gap-1.5 min-w-max">
      {displaySegments.map((segment, idx) => (
        <span key={`${segment}-${idx}`} className="inline-flex items-center gap-1">
          <span
            className={cn(
              "px-2 py-0.5 rounded-md border text-[11px] font-medium whitespace-nowrap",
              getNodeTone(idx, displaySegments.length),
            )}
          >
            {segment}
          </span>
          {idx < displaySegments.length - 1 && (
            <span className="relative inline-flex items-center w-6 h-3.5 shrink-0">
              <span
                className={cn(
                  "h-[2px] w-full rounded-full",
                  getLinkTone(idx, displaySegments.length).line,
                )}
              />
              <span
                className={cn(
                  "absolute left-1/2 -translate-x-1/2 h-1.5 w-1.5 rounded-full animate-pulse",
                  getLinkTone(idx, displaySegments.length).dot,
                )}
              />
              <ChevronRight className="absolute -right-1 h-3 w-3 text-muted-foreground/70 shrink-0" />
            </span>
          )}
        </span>
      ))}
      </div>
    </div>
  );
}

export function ProxyChainBadge({
  chains,
  truncateLabel = true,
  wrapperClassName,
  badgeClassName,
  countClassName,
  emptyClassName,
}: ProxyChainBadgeProps) {
  if (!chains || chains.length === 0) {
    return <span className={cn("text-xs text-muted-foreground", emptyClassName)}>-</span>;
  }

  const firstChain = chains[0];
  const landingProxy = firstChain.split(">").map((p) => p.trim()).filter(Boolean)[0] || firstChain;

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex items-center gap-1.5 min-w-0", wrapperClassName)}>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md bg-secondary/60 text-foreground dark:bg-secondary/40 dark:text-foreground/80 text-[11px] font-medium",
                truncateLabel ? "px-1.5 py-0.5 truncate max-w-[120px]" : "px-2 py-0.5 whitespace-nowrap",
                badgeClassName,
              )}
            >
              <Waypoints className="h-2.5 w-2.5 shrink-0" />
              {landingProxy}
            </span>
            {chains.length > 1 && (
              <span className={cn("text-[11px] text-muted-foreground shrink-0", countClassName)}>
                +{chains.length - 1}
              </span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-[560px] p-2 border border-border bg-popover text-popover-foreground shadow-xl"
        >
          <div className="max-h-[280px] overflow-auto pr-1 space-y-1.5">
            {chains.map((chain, idx) => (
              <div
                key={`${chain}-${idx}`}
                className={cn(
                  "rounded-md border border-border bg-card text-card-foreground px-2 py-1.5",
                  idx > 0 && "mt-1",
                )}
              >
                <div className="flex items-center gap-2">
                  {chains.length > 1 && (
                    <span className="inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full bg-muted text-[10px] font-semibold text-muted-foreground shrink-0">
                      {idx + 1}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <ChainFlow chain={chain} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
