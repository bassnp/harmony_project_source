/**
 * POST /api/runs/[id]/approve — HITL approval endpoint.
 *
 * Accepts the (possibly user-edited) extracted fields JSON,
 * validates against ExtractedFieldsSchema, persists as `approved_json`,
 * transitions the run from `awaiting_human` → `filling`, and kicks off
 * the filler + zip pipeline.
 *
 * Returns 409 if the run is not in `awaiting_human` status (race guard).
 */

import { type NextRequest, NextResponse } from "next/server";
import { getRun, updateRun, casStatus } from "@/lib/runs/store";
import { ExtractedFieldsSchema } from "@/lib/pdf/extractedSchema";
import { resumeAfterApproval } from "@/lib/runs/stateMachine";
import { getEventBus } from "@/lib/eventbus";
import { isValidRunId } from "@/lib/runs/ids";

/** Hard cap on the approve body so we never buffer pathologically large
 *  JSON in memory before Zod ever runs. The extracted-fields schema is
 *  small (well under 16 KB even with multiple owners) so 256 KB is safely
 *  above the legitimate ceiling. */
const MAX_APPROVE_BODY_BYTES = 256 * 1024;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  if (!isValidRunId(id)) {
    return NextResponse.json(
      { error: "Invalid run ID format" },
      { status: 400 },
    );
  }

  // --- Body-size guard (defense in depth before request.json buffers it) ----
  const declaredLen = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_APPROVE_BODY_BYTES) {
    return NextResponse.json(
      { error: "Request body too large" },
      { status: 413 },
    );
  }

  // --- Fetch run and check status -------------------------------------------
  const run = getRun(id);
  if (!run) {
    return NextResponse.json(
      { error: `Run "${id}" not found` },
      { status: 404 },
    );
  }

  if (run.status !== "awaiting_human") {
    return NextResponse.json(
      {
        error: `Run "${id}" is in status "${run.status}", not "awaiting_human"`,
      },
      { status: 409 },
    );
  }

  // --- Parse and validate body ----------------------------------------------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const validation = ExtractedFieldsSchema.safeParse(body);
  if (!validation.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: validation.error.issues },
      { status: 400 },
    );
  }

  // --- Atomically transition awaiting_human → filling ------------------------
  // CAS guards against concurrent double-tap approvals: only the first
  // request changes a row; the second sees `changes === 0` and returns 409.
  const changed = casStatus(id, "awaiting_human", "filling");
  if (changed === 0) {
    const current = getRun(id);
    return NextResponse.json(
      {
        error: `Run "${id}" is in status "${current?.status ?? "unknown"}", not "awaiting_human"`,
      },
      { status: 409 },
    );
  }

  // Persist approved data only after winning the CAS, then publish the
  // canonical run.filling event exactly once.
  const approvedJson = JSON.stringify(validation.data);
  updateRun(id, { approved_json: approvedJson });

  getEventBus().publish({
    channel: "run",
    type: "run.filling",
    runId: id,
    payload: {},
  });

  // Fire-and-forget: resume the pipeline asynchronously
  resumeAfterApproval(id).catch((err: unknown) => {
    console.error(`[approve/route] resumeAfterApproval failed for ${id}:`, err);
  });

  return NextResponse.json({ id, status: "filling" });
}
