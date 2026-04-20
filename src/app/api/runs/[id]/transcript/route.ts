/**
 * GET /api/runs/[id]/transcript — Download the JSONL transcript for a run.
 *
 * Streams the transcript.jsonl file from `/workspace/runs/<id>/transcript.jsonl`.
 * Returns 404 if the run or transcript file doesn't exist.
 * Used by the failure banner "View transcript" link.
 */

import { type NextRequest, NextResponse } from "next/server";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { getRun } from "@/lib/runs/store";
import { isValidRunId } from "@/lib/runs/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Base directory for all run artifacts inside the container volume. */
const WORKSPACE_RUNS_DIR = "/workspace/runs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const transcriptPath = path.join(WORKSPACE_RUNS_DIR, id, "transcript.jsonl");
  if (!existsSync(transcriptPath)) {
    return NextResponse.json(
      { error: "Transcript file not found for this run" },
      { status: 404 },
    );
  }

  const nodeStream = createReadStream(transcriptPath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="transcript-${id}.jsonl"`,
      "Cache-Control": "no-cache",
    },
  });
}
