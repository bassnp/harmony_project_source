/**
 * stdoutParser — Line-buffered JSONL parser for Copilot CLI stdout.
 *
 * Reads `--output-format=json` JSONL from a child process stdout stream,
 * validates each line against a Zod union of known event types, and
 * delivers typed events via a callback. Unknown event types are passed
 * through as-is (never blocked). Non-JSON lines are emitted as `raw` events.
 *
 * Ref: references/research/COPILOT_CLI_HIGH_QUALITY_REFERENCE.md §3 "Structured Output"
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Zod schemas — Copilot CLI v1.0.32 JSONL event types
//
// Derived from observed JSONL output of `copilot -p ... --output-format=json`.
// Unknown event types pass through BaseEventSchema (never blocked).
// ---------------------------------------------------------------------------

const BaseEventSchema = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
  id: z.string().optional(),
  parentId: z.string().optional(),
  ephemeral: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const UserMessageSchema = BaseEventSchema.extend({
  type: z.literal("user.message"),
  data: z.object({
    content: z.string(),
    transformedContent: z.string().optional(),
    attachments: z.array(z.unknown()).optional(),
  }).passthrough(),
});

const AssistantMessageSchema = BaseEventSchema.extend({
  type: z.literal("assistant.message"),
  data: z.object({ content: z.string() }),
});

const AssistantMessageDeltaSchema = BaseEventSchema.extend({
  type: z.literal("assistant.message_delta"),
  data: z.object({
    messageId: z.string(),
    deltaContent: z.string(),
  }),
});

const AssistantReasoningSchema = BaseEventSchema.extend({
  type: z.literal("assistant.reasoning"),
  data: z.object({
    reasoningId: z.string(),
    content: z.string(),
  }),
});

const AssistantReasoningDeltaSchema = BaseEventSchema.extend({
  type: z.literal("assistant.reasoning_delta"),
  data: z.object({
    reasoningId: z.string(),
    deltaContent: z.string(),
  }),
});

const ToolExecutionStartSchema = BaseEventSchema.extend({
  type: z.literal("tool.execution_start"),
  data: z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
});

const ToolExecutionCompleteSchema = BaseEventSchema.extend({
  type: z.literal("tool.execution_complete"),
  data: z.object({
    toolCallId: z.string(),
    success: z.boolean(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
});

const ResultSchema = BaseEventSchema.extend({
  type: z.literal("result"),
  sessionId: z.string().optional(),
});

/**
 * Discriminated union of all known Copilot CLI JSONL event types.
 * Unknown events fall through to `BaseEventSchema`.
 */
export const CopilotEventSchema = z.union([
  UserMessageSchema,
  AssistantMessageSchema,
  AssistantMessageDeltaSchema,
  AssistantReasoningSchema,
  AssistantReasoningDeltaSchema,
  ToolExecutionStartSchema,
  ToolExecutionCompleteSchema,
  ResultSchema,
  BaseEventSchema,
]);

export type CopilotEvent = z.infer<typeof CopilotEventSchema>;

// ---------------------------------------------------------------------------
// Raw fallback for non-JSON lines
// ---------------------------------------------------------------------------

/** Emitted when a stdout line is not valid JSON (ANSI junk, partial output). */
export interface RawLineEvent {
  kind: "raw";
  line: string;
}

/** Union type for all possible parser output. */
export type ParsedEvent = CopilotEvent | RawLineEvent;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export interface StdoutParserOptions {
  /** Called for each parsed event (JSON or raw). */
  onEvent: (event: ParsedEvent) => void;
  /** Called on parser-level errors (readline failure). */
  onError?: (err: Error) => void;
}

/**
 * Attach a line-buffered JSONL parser to a readable stream.
 *
 * Uses `readline.createInterface` to handle multi-byte UTF-8 boundaries
 * correctly (as recommended in COPILOT_CLI reference §2.5).
 *
 * @returns A promise that resolves when the stream is fully consumed.
 */
export function parseStdout(
  stdout: Readable,
  options: StdoutParserOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const rl: ReadlineInterface = createInterface({ input: stdout });

    rl.on("line", (line: string) => {
      // Skip empty lines
      if (!line.trim()) return;

      try {
        const parsed: unknown = JSON.parse(line);
        // Validate against the Zod union; unknown types pass through BaseEventSchema
        const result = CopilotEventSchema.safeParse(parsed);
        if (result.success) {
          options.onEvent(result.data);
        } else {
          // JSON was valid but didn't match any schema — emit as raw
          options.onEvent({ kind: "raw", line });
        }
      } catch {
        // Not valid JSON — ANSI decoration, partial output, etc.
        options.onEvent({ kind: "raw", line });
      }
    });

    rl.on("error", (err: Error) => {
      options.onError?.(err);
      reject(err);
    });

    rl.on("close", () => {
      resolve();
    });
  });
}

/**
 * Type guard: check if a ParsedEvent is a structured Copilot event (not raw).
 */
export function isCopilotEvent(event: ParsedEvent): event is CopilotEvent {
  return "type" in event && !("kind" in event);
}
