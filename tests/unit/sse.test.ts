/**
 * Unit tests for src/lib/sse.ts
 *
 * Coverage:
 *   - formatSSE: correct SSE frame structure
 *   - formatHeartbeat: SSE comment format
 *   - createSSEStream: delivers events, closes on abort
 */

import { describe, it, expect } from "vitest";
import { formatSSE, formatHeartbeat, createSSEStream } from "@/lib/sse";
import { EventBus, type BusEvent } from "@/lib/eventbus";

// ---------------------------------------------------------------------------
// formatSSE
// ---------------------------------------------------------------------------

describe("formatSSE", () => {
  it("produces correct SSE frame with all fields", () => {
    const event: BusEvent = {
      id: "01ABCDEF",
      seq: 42,
      ts: "2025-01-01T00:00:00.000Z",
      channel: "agent",
      type: "agent.stdout",
      runId: "run-123",
      payload: { line: "hello" },
    };

    const frame = formatSSE(event);
    const lines = frame.split("\n");

    expect(lines[0]).toBe("event: agent");
    expect(lines[1]).toBe("id: 01ABCDEF");
    expect(lines[2]).toMatch(/^data: /);

    // Parse the data JSON and verify contents
    const data = JSON.parse(lines[2]!.replace("data: ", ""));
    expect(data.type).toBe("agent.stdout");
    expect(data.seq).toBe(42);
    expect(data.ts).toBe("2025-01-01T00:00:00.000Z");
    expect(data.runId).toBe("run-123");
    expect(data.payload).toEqual({ line: "hello" });

    // Must end with double newline
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("handles event without runId or payload", () => {
    const event: BusEvent = {
      id: "01X",
      seq: 1,
      ts: "2025-01-01T00:00:00.000Z",
      channel: "run",
      type: "run.started",
    };

    const frame = formatSSE(event);
    expect(frame).toContain("event: run");
    expect(frame).toContain("id: 01X");

    const data = JSON.parse(frame.split("\n")[2]!.replace("data: ", ""));
    expect(data.runId).toBeUndefined();
    expect(data.payload).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatHeartbeat
// ---------------------------------------------------------------------------

describe("formatHeartbeat", () => {
  it("produces SSE comment line", () => {
    const hb = formatHeartbeat();
    expect(hb).toBe(": heartbeat\n\n");
  });
});

// ---------------------------------------------------------------------------
// createSSEStream
// ---------------------------------------------------------------------------

describe("createSSEStream", () => {
  it("delivers published events through the stream", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe({ runId: "test-run" });
    const ac = new AbortController();

    const stream = createSSEStream(sub, ac.signal);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // Drain the immediate heartbeat the stream emits on connect.
    await reader.read();

    // Publish an event
    bus.publish({
      channel: "agent",
      type: "agent.stdout",
      runId: "test-run",
      payload: "hello",
    });

    // Read from the stream (the next event after the heartbeat)
    const { value, done } = await reader.read();
    expect(done).toBe(false);

    const text = decoder.decode(value);
    expect(text).toContain("event: agent");
    expect(text).toContain("agent.stdout");
    expect(text).toContain("hello");

    // Cleanup
    ac.abort();
    reader.releaseLock();
  });

  it("closes stream when abort signal fires", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    const ac = new AbortController();

    const stream = createSSEStream(sub, ac.signal);
    const reader = stream.getReader();

    // Drain the immediate heartbeat so the next read can observe done.
    await reader.read();

    // Abort
    ac.abort();

    // Give the async pump a tick to process the abort
    await new Promise<void>((r) => setTimeout(r, 50));

    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("closes stream when subscription is closed", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    const ac = new AbortController();

    const stream = createSSEStream(sub, ac.signal);
    const reader = stream.getReader();

    // Drain the immediate heartbeat first.
    await reader.read();

    // Close the subscription externally
    sub.close();

    // Give the async pump a tick to process
    await new Promise<void>((r) => setTimeout(r, 50));

    const { done } = await reader.read();
    expect(done).toBe(true);

    ac.abort();
  });

  it("handles payload with embedded newlines safely via JSON.stringify", () => {
    const event: BusEvent = {
      id: "01NL",
      seq: 1,
      ts: "2025-01-01T00:00:00.000Z",
      channel: "agent",
      type: "agent.stdout",
      payload: { text: "line1\nline2\nline3" },
    };

    const frame = formatSSE(event);
    // Each SSE data: line should be a single line — JSON.stringify escapes \n
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
    expect(dataLine).toBeDefined();
    // The data line should NOT contain a raw newline inside the JSON
    const json = dataLine!.slice(6);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.payload.text).toBe("line1\nline2\nline3");
  });

  it("delivers multiple rapid events in sequence", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe({ runId: "rapid-test" });
    const ac = new AbortController();

    const stream = createSSEStream(sub, ac.signal);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // Drain the immediate heartbeat the stream emits on connect.
    await reader.read();

    // Publish 5 events in rapid succession
    for (let i = 0; i < 5; i++) {
      bus.publish({ channel: "agent", type: "t", runId: "rapid-test", payload: i });
    }

    // Read and collect all 5 (skipping any interleaved heartbeats)
    let collected = "";
    let eventChunks = 0;
    while (eventChunks < 5) {
      const { value } = await reader.read();
      const chunk = decoder.decode(value);
      collected += chunk;
      // Heartbeats are pure SSE comments; only count event frames.
      if (chunk.includes("event: ")) eventChunks += 1;
    }

    // Verify all 5 events present
    for (let i = 0; i < 5; i++) {
      expect(collected).toContain(`"payload":${i}`);
    }

    ac.abort();
    reader.releaseLock();
  });

  it("emits an immediate heartbeat on connect (no 15s silent gap)", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe({ runId: "hb-test" });
    const ac = new AbortController();

    const stream = createSSEStream(sub, ac.signal);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // First read should resolve almost immediately with the heartbeat.
    const first = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 500),
      ),
    ]);

    expect(first.done).toBe(false);
    expect(first.value).toBeDefined();
    expect(decoder.decode(first.value!)).toBe(": heartbeat\n\n");

    ac.abort();
    reader.releaseLock();
  });

  it("dedupes events with seq <= sinceSeq (replay race protection)", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe({ runId: "dedupe" });
    const ac = new AbortController();

    // Publish two events BEFORE the stream starts; both are now queued
    // in the subscription. We treat seq=2 as "already replayed" and pass
    // sinceSeq=2 to the stream, which must skip both.
    bus.publish({ channel: "agent", type: "t", runId: "dedupe", payload: "skip-1" });
    bus.publish({ channel: "agent", type: "t", runId: "dedupe", payload: "skip-2" });

    const stream = createSSEStream(sub, ac.signal, { sinceSeq: 2 });
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // First chunk = immediate heartbeat (not an event).
    const hb = await reader.read();
    expect(decoder.decode(hb.value!)).toBe(": heartbeat\n\n");

    // Now publish a new event with seq=3 — this MUST come through.
    bus.publish({ channel: "agent", type: "t", runId: "dedupe", payload: "keep-3" });

    const next = await reader.read();
    const text = decoder.decode(next.value!);
    expect(text).toContain(`"payload":"keep-3"`);
    expect(text).not.toContain("skip-1");
    expect(text).not.toContain("skip-2");

    ac.abort();
    reader.releaseLock();
  });
});
