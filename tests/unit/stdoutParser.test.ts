/**
 * stdoutParser.test — Unit tests for the Copilot CLI JSONL parser.
 *
 * Covers: happy-path event types, malformed JSON, empty lines,
 * unknown event types (passthrough), type guard, and stream errors.
 */

import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  parseStdout,
  isCopilotEvent,
  CopilotEventSchema,
  type ParsedEvent,
} from "@/lib/copilot/stdoutParser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a Readable stream from an array of lines (simulates child stdout). */
function streamFromLines(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + "\n").join(""));
}

/** Collect all events from parsing a stream. */
async function collectEvents(lines: string[]): Promise<ParsedEvent[]> {
  const events: ParsedEvent[] = [];
  await parseStdout(streamFromLines(lines), {
    onEvent: (e) => events.push(e),
  });
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stdoutParser", () => {
  describe("CopilotEventSchema", () => {
    it("validates an assistant.message event", () => {
      const raw = {
        type: "assistant.message",
        data: { content: "Hello world" },
        timestamp: "2026-04-16T10:30:46.456Z",
      };
      const result = CopilotEventSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("assistant.message");
      }
    });

    it("validates a tool.execution_start event", () => {
      const raw = {
        type: "tool.execution_start",
        data: { toolCallId: "tc_123", toolName: "mcp-pdf.extract_text", arguments: { path: "/tmp/a.pdf" } },
      };
      const result = CopilotEventSchema.safeParse(raw);
      expect(result.success).toBe(true);
    });

    it("validates a tool.execution_complete event", () => {
      const raw = {
        type: "tool.execution_complete",
        data: { toolCallId: "tc_123", success: true, result: { content: "some text" } },
      };
      const result = CopilotEventSchema.safeParse(raw);
      expect(result.success).toBe(true);
    });

    it("validates a result event", () => {
      const raw = {
        type: "result",
        sessionId: "sess_abc",
        timestamp: "2026-04-16T10:30:46.456Z",
      };
      const result = CopilotEventSchema.safeParse(raw);
      expect(result.success).toBe(true);
    });

    it("validates an assistant.reasoning event", () => {
      const raw = {
        type: "assistant.reasoning",
        data: { reasoningId: "r_123", content: "Thinking about..." },
      };
      const result = CopilotEventSchema.safeParse(raw);
      expect(result.success).toBe(true);
    });

    it("validates an assistant.message_delta event", () => {
      const raw = {
        type: "assistant.message_delta",
        data: { messageId: "m_123", deltaContent: "Hello" },
      };
      const result = CopilotEventSchema.safeParse(raw);
      expect(result.success).toBe(true);
    });

    it("passes through unknown event types via BaseEvent", () => {
      const raw = {
        type: "future.unknown.type",
        data: { foo: "bar" },
      };
      const result = CopilotEventSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("future.unknown.type");
      }
    });

    it("rejects non-object input", () => {
      const result = CopilotEventSchema.safeParse("not an object");
      expect(result.success).toBe(false);
    });
  });

  describe("parseStdout", () => {
    it("parses valid JSONL lines into typed events", async () => {
      const lines = [
        JSON.stringify({ type: "user.message", data: { content: "hello" } }),
        JSON.stringify({ type: "assistant.message", data: { content: "world" } }),
        JSON.stringify({ type: "result", sessionId: "sess_1", timestamp: "2026-04-16T10:30:46.456Z" }),
      ];

      const events = await collectEvents(lines);
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ type: "user.message" });
      expect(events[1]).toMatchObject({ type: "assistant.message" });
      expect(events[2]).toMatchObject({ type: "result" });
    });

    it("skips empty lines", async () => {
      const lines = [
        "",
        JSON.stringify({ type: "assistant.message", data: { content: "hi" } }),
        "   ",
        "",
      ];

      const events = await collectEvents(lines);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "assistant.message" });
    });

    it("emits raw events for non-JSON lines (ANSI junk)", async () => {
      const lines = [
        "\x1b[32mSome ANSI output\x1b[0m",
        JSON.stringify({ type: "assistant.message", data: { content: "ok" } }),
      ];

      const events = await collectEvents(lines);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: "raw",
        line: "\x1b[32mSome ANSI output\x1b[0m",
      });
      expect(events[1]).toMatchObject({ type: "assistant.message" });
    });

    it("emits raw for JSON that fails schema validation", async () => {
      // Valid JSON but doesn't match any CopilotEvent (missing `type`)
      const lines = [
        JSON.stringify({ notType: "oops", data: {} }),
      ];

      const events = await collectEvents(lines);
      expect(events).toHaveLength(1);
      expect(events[0]).toHaveProperty("kind", "raw");
    });

    it("calls onError when readline errors", async () => {
      const errStream = new Readable({
        read() {
          this.destroy(new Error("stream failure"));
        },
      });

      const errors: Error[] = [];
      await expect(
        parseStdout(errStream, {
          onEvent: () => {},
          onError: (err) => errors.push(err),
        }),
      ).rejects.toThrow("stream failure");
      expect(errors).toHaveLength(1);
    });

    it("handles a mix of valid, invalid, and empty lines", async () => {
      const lines = [
        JSON.stringify({ type: "tool.execution_start", data: { toolCallId: "tc_1", toolName: "read", arguments: { path: "x" } } }),
        "garbage line",
        "",
        JSON.stringify({ type: "tool.execution_complete", data: { toolCallId: "tc_1", success: true, result: { content: "result" } } }),
        "more garbage",
      ];

      const events = await collectEvents(lines);
      expect(events).toHaveLength(4);
      // tool.execution_start, raw, tool.execution_complete, raw
      expect(events[0]).toMatchObject({ type: "tool.execution_start" });
      expect(events[1]).toMatchObject({ kind: "raw", line: "garbage line" });
      expect(events[2]).toMatchObject({ type: "tool.execution_complete" });
      expect(events[3]).toMatchObject({ kind: "raw", line: "more garbage" });
    });
  });

  describe("isCopilotEvent", () => {
    it("returns true for structured events", () => {
      const event: ParsedEvent = {
        type: "assistant.message",
        data: { content: "hi" },
      };
      expect(isCopilotEvent(event)).toBe(true);
    });

    it("returns false for raw events", () => {
      const event: ParsedEvent = { kind: "raw", line: "junk" };
      expect(isCopilotEvent(event)).toBe(false);
    });
  });
});
