/**
 * POST /api/runs/[id]/cancel — Cancel a run (reject & restart).
 *
 * Transitions the run to `failed` from any non-terminal state.
 * Used by the HITL modal "Reject & Restart" button to abort
 * the current pipeline and allow a fresh upload.
 *
 * Returns 404 if the run doesn't exist.
 * Returns 409 if the run is already in a terminal state (done/failed).
 */

import { type NextRequest, NextResponse } from "next/server";
import { getRun, casFailFromNonTerminal } from "@/lib/runs/store";
import { getEventBus } from "@/lib/eventbus";
import { isValidRunId } from "@/lib/runs/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  if (!isValidRunId(id)) {
    return NextResponse.json(
      { error: "Invalid run ID format" },
      { status: 400 },
    );
  }

  const run = getRun(id);
  if (!run) {
    return NextResponse.json(
      { error: `Run "${id}" not found` },
      { status: 404 },
    );
  }

  // Atomic transition: only succeeds for non-terminal status. This eliminates
  // the read-then-write race against the orchestrator (which may itself be
  // mid-transition when the cancel arrives).
  const changed = casFailFromNonTerminal(id, "Cancelled by user");
  if (changed === 0) {
    const current = getRun(id);
    return NextResponse.json(
      {
        error: `Run "${id}" is already in terminal status "${current?.status ?? "unknown"}" and cannot be cancelled`,
      },
      { status: 409 },
    );
  }

  // Publish the canonical run.failed event exactly once.
  getEventBus().publish({
    channel: "run",
    type: "run.failed",
    runId: id,
    payload: { error: "Cancelled by user" },
  });

  return NextResponse.json({ id, status: "failed" });
}
