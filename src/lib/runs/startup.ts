/**
 * startup — One-time recovery guard executed on service boot.
 *
 * When the Docker container restarts (via RESTART_SERVICE.bat, Docker Desktop
 * restart, OOM kill, or any crash), in-progress Copilot child processes are
 * terminated. Runs that were in non-terminal intermediate states (`ingested`,
 * `extracting`, `filling`, `zipping`) become permanently stuck because no
 * process is driving them forward.
 *
 * This module detects and resets those orphaned runs to `failed` exactly once
 * per process lifetime. The guard is idempotent — calling `ensureStartupRecovery()`
 * multiple times (e.g., from concurrent API requests) only executes recovery once.
 *
 * Design decisions:
 *   - `awaiting_human` is NOT reset: it's a deliberate HITL pause that doesn't
 *     require a running child process. Users can still approve or cancel.
 *   - Uses `globalThis` flag to survive Next.js HMR reloads in development.
 *   - Publishes `run.failed` events for each reset run so connected SSE clients
 *     receive the state change immediately.
 *
 * Ref: references/research/ORCHESTRATION_HIGH_QUALITY_REFERENCE.md §4 (lifecycle)
 */

import { resetStaleRuns, listRuns } from "@/lib/runs/store";
import { getEventBus } from "@/lib/eventbus";

// ---------------------------------------------------------------------------
// Global guard — ensures recovery runs exactly once per process lifetime.
// Anchored on `globalThis` so it persists across Next.js HMR reloads.
// ---------------------------------------------------------------------------

declare global {
  var __hcdStartupRecoveryDone: boolean | undefined;
}

/** The error message applied to runs reset by startup recovery. */
const RECOVERY_ERROR =
  "Run interrupted by service restart. The process driving this run was terminated. " +
  "Please start a new run.";

/**
 * Execute startup recovery if it hasn't been done yet this process lifetime.
 *
 * Safe to call from any point (API route, middleware, health check).
 * Only the first invocation performs work; subsequent calls are no-ops.
 *
 * @returns The number of runs that were reset (0 if recovery already ran or no stale runs).
 */
export function ensureStartupRecovery(): number {
  if (globalThis.__hcdStartupRecoveryDone) return 0;
  globalThis.__hcdStartupRecoveryDone = true;

  const resetCount = resetStaleRuns(RECOVERY_ERROR);

  if (resetCount > 0) {
    // Publish failure events for each reset run so SSE subscribers update
    const bus = getEventBus();
    const allRuns = listRuns();
    const resetRuns = allRuns.filter(
      (r) => r.status === "failed" && r.error === RECOVERY_ERROR,
    );
    for (const run of resetRuns) {
      bus.publish({
        channel: "run",
        type: "run.failed",
        runId: run.id,
        payload: { error: RECOVERY_ERROR },
      });
    }

    console.log(
      `[startup-recovery] Reset ${resetCount} stale run(s) to failed after service restart.`,
    );
  }

  return resetCount;
}
