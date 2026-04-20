/**
 * GET /api/runs/[id] — Fetch a single run's status and metadata.
 *
 * Returns the full run row from SQLite. Used by the UI to poll
 * status (e.g. waiting for `done`) and by the Gate Check.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/runs/store";
import { isValidRunId } from "@/lib/runs/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
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

  return NextResponse.json(run);
}
