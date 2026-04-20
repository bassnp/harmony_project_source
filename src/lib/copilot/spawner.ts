/**
 * spawner — Typed harness for launching Copilot CLI as a child process.
 *
 * Materializes per-run config via `configBuilder`, spawns `copilot` with
 * `--model=claude-haiku-4.5 --output-format=json --no-ask-user --allow-all-tools`,
 * parses JSONL stdout via `stdoutParser`, republishes events onto the EventBus,
 * appends each event to a JSONL transcript file, and resolves with a summary.
 *
 * Ref: references/research/COPILOT_CLI_HIGH_QUALITY_REFERENCE.md §2.1, §3
 * Ref: references/research/ORCHESTRATION_HIGH_QUALITY_REFERENCE.md §2.4, §2.6
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getEventBus } from "@/lib/eventbus";
import { buildRunConfig } from "@/lib/copilot/configBuilder";
import {
  parseStdout,
  isCopilotEvent,
  type ParsedEvent,
} from "@/lib/copilot/stdoutParser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for a single Copilot CLI invocation. */
export interface SpawnCopilotOptions {
  /** Unique run identifier (ULID). */
  runId: string;
  /** Full prompt text passed to `-p`. */
  promptText: string;
  /** Working directory for the child process. */
  cwd: string;
  /** Hard timeout in milliseconds. Default: 600_000 (10 min). */
  timeoutMs?: number;
  /** Base directory for per-run agent state. Default: `/workspace/agents`. */
  agentBaseDir?: string;
}

/** Result returned when the Copilot process exits. */
export interface SpawnCopilotResult {
  /** Process exit code (0 = success). */
  exitCode: number;
  /** All parsed events collected during the run. */
  transcript: ParsedEvent[];
  /** Content of the last `assistant.message` event, or empty string. */
  finalAssistantText: string;
  /**
   * Stringified result payloads from all `tool.execution_complete` events.
   * Used as a fallback source for JSON extraction when the model writes
   * the JSON via a tool call instead of returning it in the final message.
   */
  toolResultTexts: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default hard timeout: 10 minutes. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Grace period after SIGTERM before SIGKILL. */
const SIGKILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn a Copilot CLI child process, parse its JSONL output, and
 * publish events to the EventBus.
 *
 * The function:
 * 1. Materializes per-run `.copilot/` config via `buildRunConfig`.
 * 2. Spawns `copilot -p <prompt> --model=claude-haiku-4.5 --output-format=json --allow-all-tools`.
 * 3. Parses stdout JSONL via `stdoutParser`, publishing each event to the bus.
 * 4. Appends every event to `<cwd>/transcript.jsonl`.
 * 5. Enforces a hard timeout (SIGTERM → SIGKILL after grace period).
 * 6. Resolves with exit code, full transcript, and final assistant text.
 *
 * @throws If `COPILOT_GITHUB_TOKEN` is not set in the environment.
 */
export async function spawnCopilot(
  options: SpawnCopilotOptions,
): Promise<SpawnCopilotResult> {
  const {
    runId,
    promptText,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    agentBaseDir,
  } = options;

  // --- Validate required environment ----------------------------------------
  const token = process.env["COPILOT_GITHUB_TOKEN"];
  if (!token) {
    throw new Error(
      "COPILOT_GITHUB_TOKEN is not set. Add it to your .env file.",
    );
  }

  // --- Materialize per-run config -------------------------------------------
  const configDir = await buildRunConfig({
    runId,
    baseDir: agentBaseDir,
  });

  // --- Ensure transcript directory exists -----------------------------------
  await mkdir(cwd, { recursive: true });
  const transcriptPath = path.join(cwd, "transcript.jsonl");

  // --- Build argv -----------------------------------------------------------
  const argv: string[] = [
    "-p",
    promptText,
    "--model=claude-haiku-4.5",
    "--output-format=json",
    "--no-ask-user",
    "--allow-all-tools",
    "--config-dir",
    configDir,
  ];

  // --- Spawn child process --------------------------------------------------
  const bus = getEventBus();
  const transcript: ParsedEvent[] = [];
  let finalAssistantText = "";
  /** Accumulate assistant.message_delta content as fallback for finalAssistantText. */
  let deltaAccumulator = "";
  let lastDeltaMessageId = "";
  /** Collect stringified tool results for JSON extraction fallback. */
  const toolResultTexts: string[] = [];

  const child: ChildProcess = spawn("copilot", argv, {
    cwd,
    env: {
      ...process.env,
      COPILOT_HOME: configDir,
      COPILOT_GITHUB_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // --- Hard timeout with SIGTERM → SIGKILL ----------------------------------
  let timedOut = false;
  let forceKillHandle: NodeJS.Timeout | undefined;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKillHandle = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, SIGKILL_GRACE_MS);
  }, timeoutMs);

  // --- Parse stdout JSONL ---------------------------------------------------
  const stdoutDone = child.stdout
    ? parseStdout(child.stdout, {
        onEvent: (event: ParsedEvent) => {
          transcript.push(event);

          // Track last assistant message for the final result.
          // The CLI emits streaming `assistant.message_delta` events followed
          // by a final `assistant.message` with the full accumulated content.
          if (isCopilotEvent(event)) {
            if (event.type === "assistant.message") {
              const data = event.data as { content?: string } | undefined;
              if (data?.content) {
                finalAssistantText = data.content;
                // Reset delta accumulator since we got the full message
                deltaAccumulator = "";
                lastDeltaMessageId = "";
              }
            } else if (event.type === "tool.execution_complete") {
              // Capture tool result text for JSON extraction fallback.
              // The model may write JSON via bash/tool call instead of
              // returning it in the final assistant message.
              const data = event.data as {
                result?: Record<string, unknown>;
              } | undefined;
              if (data?.result) {
                toolResultTexts.push(JSON.stringify(data.result));
              }
            } else if (event.type === "assistant.message_delta") {
              const data = event.data as { messageId?: string; deltaContent?: string } | undefined;
              if (data?.deltaContent) {
                // Reset accumulator if a new message starts
                if (data.messageId && data.messageId !== lastDeltaMessageId) {
                  deltaAccumulator = "";
                  lastDeltaMessageId = data.messageId ?? "";
                }
                deltaAccumulator += data.deltaContent;
              }
            }
          }

          // Publish to EventBus
          if (isCopilotEvent(event)) {
            bus.publish({
              channel: "agent",
              type: event.type,
              runId,
              payload: event.data,
            });
          } else {
            bus.publish({
              channel: "agent",
              type: "agent.raw",
              runId,
              payload: { line: event.line },
            });
          }

          // Append to transcript file (fire-and-forget; log errors)
          appendFile(
            transcriptPath,
            JSON.stringify(event) + "\n",
            "utf-8",
          ).catch((err: unknown) => {
            console.error("[spawner] transcript write error:", err);
          });
        },
        onError: (err: Error) => {
          console.error("[spawner] stdout parse error:", err);
        },
      })
    : Promise.resolve();

  // --- Capture stderr for diagnostics ---------------------------------------
  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  // --- Wait for both stdout drain AND process exit --------------------------
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", (err: Error) => {
      clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      reject(err);
    });

    child.on("exit", (code: number | null) => {
      clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      resolve(code ?? 1);
    });
  });

  // Wait for stdout to fully drain before returning
  await stdoutDone;

  // Publish timeout event if applicable
  if (timedOut) {
    bus.publish({
      channel: "agent",
      type: "agent.timeout",
      runId,
      payload: { timeoutMs },
    });
  }

  // If no final assistant.message had content, fall back to accumulated deltas
  if (!finalAssistantText && deltaAccumulator) {
    finalAssistantText = deltaAccumulator;
  }

  return {
    exitCode,
    transcript,
    finalAssistantText,
    toolResultTexts,
  };
}
