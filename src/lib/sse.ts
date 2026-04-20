/**
 * SSE helpers — ReadableStream factory for Server-Sent Events.
 *
 * Emits heartbeat comments every 15 s to defeat proxy idle timeouts,
 * serializes BusEvents as `event: <channel>\nid: <id>\ndata: <json>\n\n`,
 * and checks `controller.desiredSize` for backpressure.
 *
 * Design ref: references/research/NEXTJS_BACKEND_HIGH_QUALITY_REFERENCE.md §5
 */

import type { BusEvent, Subscription } from "@/lib/eventbus";

// ---------------------------------------------------------------------------
// SSE frame formatter
// ---------------------------------------------------------------------------

/**
 * Format a BusEvent as an SSE frame string.
 *
 * Output:
 * ```
 * event: <channel>
 * id: <id>
 * data: {"type":"...","seq":...,"ts":"...","runId":"...","payload":...}
 * <blank line>
 * ```
 */
export function formatSSE(event: BusEvent): string {
  const data = JSON.stringify({
    type: event.type,
    seq: event.seq,
    ts: event.ts,
    runId: event.runId,
    payload: event.payload,
  });
  return `event: ${event.channel}\nid: ${event.id}\ndata: ${data}\n\n`;
}

/** Format a heartbeat SSE comment (ignored by browsers, resets proxy timers). */
export function formatHeartbeat(): string {
  return `: heartbeat\n\n`;
}

// ---------------------------------------------------------------------------
// SSE ReadableStream factory
// ---------------------------------------------------------------------------

/** Heartbeat interval in milliseconds (15 s — sweet spot for 30–120 s proxy timeouts). */
const HEARTBEAT_MS = 15_000;

/** Backpressure poll interval in milliseconds. */
const BACKPRESSURE_POLL_MS = 50;

/**
 * Create a `ReadableStream<Uint8Array>` that pipes BusEvents from a
 * `Subscription` as SSE frames, with heartbeat and backpressure handling.
 *
 * The stream:
 *   - Emits an immediate heartbeat comment so reverse proxies and the
 *     browser register the connection as live within the first
 *     turnaround instead of waiting for the first 15 s tick.
 *   - Optionally drops events whose `seq <= sinceSeq` to deduplicate
 *     against a replay buffer the route prepends (Last-Event-ID flow).
 *
 * The stream closes when:
 * - The subscription is closed (e.g. bus shutdown).
 * - The `signal` is aborted (client disconnect / request cancelled).
 */
export function createSSEStream(
  subscription: Subscription,
  signal: AbortSignal,
  options: { sinceSeq?: number } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const sinceSeq = options.sinceSeq ?? 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // --- Immediate heartbeat ----------------------------------------------
      // Without this, a quiet stream emits zero bytes for up to HEARTBEAT_MS,
      // making the connection look hung to clients and intermediaries.
      try {
        controller.enqueue(encoder.encode(formatHeartbeat()));
      } catch {
        // Stream already closed — nothing to do.
      }

      // --- Heartbeat timer ---------------------------------------------------
      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(formatHeartbeat()));
        } catch {
          // Stream already closed — timer will be cleared by cleanup.
        }
      }, HEARTBEAT_MS);

      // --- Cleanup on abort --------------------------------------------------
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(hb);
        subscription.close();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      signal.addEventListener("abort", cleanup, { once: true });

      // --- Async event pump --------------------------------------------------
      (async () => {
        while (!signal.aborted) {
          const event = await subscription.waitForNext();
          if (event === null) break; // Subscription closed.

          // Dedupe against any events the route already replayed from
          // the bus log (Last-Event-ID flow). Events with seq at or
          // below the cutoff are guaranteed to have been replayed.
          if (sinceSeq > 0 && event.seq <= sinceSeq) continue;

          // Backpressure: pause if the stream's internal buffer is full.
          while ((controller.desiredSize ?? 1) <= 0 && !signal.aborted) {
            await new Promise<void>((r) => setTimeout(r, BACKPRESSURE_POLL_MS));
          }
          if (signal.aborted) break;

          try {
            controller.enqueue(encoder.encode(formatSSE(event)));
          } catch {
            break; // Stream closed by consumer.
          }
        }
        cleanup();
      })();
    },
  });
}

// ---------------------------------------------------------------------------
// Standard SSE response headers
// ---------------------------------------------------------------------------

/** Headers required for a well-behaved SSE response. */
export const SSE_HEADERS: HeadersInit = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};
