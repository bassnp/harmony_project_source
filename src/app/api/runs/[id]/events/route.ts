/**
 * GET /api/runs/[id]/events — Server-Sent Events stream for a specific run.
 *
 * Subscribes to the singleton EventBus filtered by `runId`, pipes events
 * as SSE frames with heartbeat. Connection closes on client disconnect
 * (request.signal abort) or when the subscription ends.
 *
 * Config:
 *   runtime = 'nodejs'       — Node.js runtime (not Edge; we need process-level APIs)
 *   dynamic = 'force-dynamic' — never cache; always request-time
 *   maxDuration = 600         — 10 min max before serverless platforms kill the fn
 *
 * Design ref: references/research/NEXTJS_BACKEND_HIGH_QUALITY_REFERENCE.md §5
 */

import { type NextRequest, NextResponse } from "next/server";
import { getEventBus } from "@/lib/eventbus";
import { getRun } from "@/lib/runs/store";
import { createSSEStream, formatSSE, SSE_HEADERS } from "@/lib/sse";
import { isValidRunId } from "@/lib/runs/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "default-no-store";
export const maxDuration = 600;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: runId } = await params;

  if (!isValidRunId(runId)) {
    return NextResponse.json(
      { error: "Invalid run ID format" },
      { status: 400 },
    );
  }

  // Guard: reject SSE connections for non-existent runs to avoid hanging
  const run = getRun(runId);
  if (!run) {
    return NextResponse.json(
      { error: `Run "${runId}" not found` },
      { status: 404 },
    );
  }

  const bus = getEventBus();
  const subscription = bus.subscribe({ runId });

  // --- Last-Event-ID replay for SSE reconnect --------------------------------
  // The browser's EventSource sends `Last-Event-ID` on reconnect containing
  // the `id` (ULID) of the last successfully received event. We map it back
  // to a monotonic seq via the replay log and pre-fill missed events.
  //
  // Race note: we subscribe BEFORE computing the replay snapshot. New events
  // arriving in that window land in BOTH the replay snapshot and the
  // subscriber queue. We pass `sinceSeq = highestReplayedSeq` to the stream
  // so it skips queue events already emitted via the replay frames.
  const lastEventId = request.headers.get("Last-Event-ID");
  let replayFrames = "";
  let sinceSeq = 0;
  if (lastEventId) {
    const allRecent = bus.replayFrom(0, { runId });
    const lastIdx = allRecent.findIndex((ev) => ev.id === lastEventId);
    if (lastIdx >= 0) {
      const missed = allRecent.slice(lastIdx + 1);
      if (missed.length > 0) {
        replayFrames = missed.map((ev) => formatSSE(ev)).join("");
        sinceSeq = missed[missed.length - 1]!.seq;
      }
    }
  }

  const stream = createSSEStream(subscription, request.signal, { sinceSeq });

  // If we have replay frames, prepend them to the stream.
  if (replayFrames) {
    const encoder = new TextEncoder();
    const replayBytes = encoder.encode(replayFrames);
    const combined = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(replayBytes);
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });
    return new Response(combined, { status: 200, headers: SSE_HEADERS });
  }

  return new Response(stream, {
    status: 200,
    headers: SSE_HEADERS,
  });
}
