"use client";

/**
 * ProgressBar — Visual pipeline progress indicator driven by run status.
 *
 * Maps orchestrator run statuses to percentage:
 *   ingested: 10 | extracting: 30 | awaiting_human: 50
 *   filling: 75 | zipping: 90 | done: 100 | failed: current
 */

import * as ProgressPrimitive from "@radix-ui/react-progress";

// ---------------------------------------------------------------------------
// Status → percent mapping (from Phase P6 spec)
// ---------------------------------------------------------------------------

/** Map of run status to progress percentage. */
const STATUS_PERCENT: Record<string, number> = {
  ingested: 10,
  extracting: 30,
  awaiting_human: 50,
  filling: 75,
  zipping: 90,
  done: 100,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProgressBarProps {
  /** Current run status, or null when idle. */
  status: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProgressBar({ status }: ProgressBarProps) {
  const percent = status ? (STATUS_PERCENT[status] ?? 0) : 0;
  const isFailed = status === "failed";

  return (
    <div className="w-full px-1">
      <div className="mb-1 flex items-center justify-between text-xs text-neutral-400">
        <span>{status ? status.replace(/_/g, " ") : "idle"}</span>
        <span>{percent}%</span>
      </div>
      <ProgressPrimitive.Root
        className="relative h-2 w-full overflow-hidden rounded-full bg-neutral-800"
        value={percent}
      >
        <ProgressPrimitive.Indicator
          className={`h-full transition-all duration-500 ease-out ${
            isFailed ? "bg-red-500" : "bg-emerald-500"
          }`}
          style={{ width: `${percent}%` }}
        />
      </ProgressPrimitive.Root>
    </div>
  );
}
