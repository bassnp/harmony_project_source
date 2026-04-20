/**
 * GET /api/runs/[id]/download — Serve the ZIP packet for a completed run.
 *
 * Streams the ZIP file as `application/zip` with a `Content-Disposition`
 * header for browser download. Only available when status is `done`.
 */

import { type NextRequest, NextResponse } from "next/server";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getRun } from "@/lib/runs/store";
import { isValidRunId } from "@/lib/runs/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse | Response> {
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

  if (run.status !== "done") {
    return NextResponse.json(
      { error: `Run "${id}" is in status "${run.status}", not "done"` },
      { status: 409 },
    );
  }

  if (!run.zip_path || !existsSync(run.zip_path)) {
    return NextResponse.json(
      { error: `ZIP file not found for run "${id}"` },
      { status: 404 },
    );
  }

  const stat = statSync(run.zip_path);
  const nodeStream = createReadStream(run.zip_path);
  // Convert Node.js Readable into a web ReadableStream for the Response API.
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  const filename = path.basename(run.zip_path);

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(stat.size),
    },
  });
}
