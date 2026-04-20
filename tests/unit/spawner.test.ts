/**
 * spawner.test — Unit tests for the Copilot CLI spawn harness.
 *
 * Uses a mock child process to test event parsing, EventBus publishing,
 * transcript persistence, timeout handling, and error paths without
 * needing the actual Copilot CLI binary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mock child_process.spawn BEFORE importing spawner
// ---------------------------------------------------------------------------

/** Create a fake ChildProcess with controllable stdout, stderr, and exit. */
function createMockChild() {
  const emitter = new EventEmitter();
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
    pid: 12345,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killCalls: [] as string[],
    kill(signal?: NodeJS.Signals) {
      this.killed = true;
      this.killCalls.push(signal ?? "SIGTERM");
      return true;
    },
  });
  return child;
}

let mockChild: ReturnType<typeof createMockChild>;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockChild),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(async () => undefined),
  };
});

// Also mock configBuilder so it doesn't write to /run/agents
vi.mock("@/lib/copilot/configBuilder", () => ({
  buildRunConfig: vi.fn(async (opts: { runId: string; baseDir?: string }) => {
    const base = opts.baseDir ?? tmpdir();
    return path.join(base, opts.runId, ".copilot");
  }),
}));

// Now import the module under test
import { spawnCopilot } from "@/lib/copilot/spawner";
import { getEventBus } from "@/lib/eventbus";

const childProcessMod = await import("node:child_process");
const spawnMock = vi.mocked(childProcessMod.spawn);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "spawner-test-"));
  mockChild = createMockChild();
  spawnMock.mockClear();
  // Set required env
  process.env["COPILOT_GITHUB_TOKEN"] = "test-token-12345";
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env["COPILOT_GITHUB_TOKEN"];
  await rm(tempDir, { recursive: true, force: true });
});

/** Push JSONL lines into mock stdout then close it. */
function emitLines(lines: string[], exitCode = 0) {
  // Delay to let parser attach
  setTimeout(() => {
    for (const line of lines) {
      mockChild.stdout.push(line + "\n");
    }
    mockChild.stdout.push(null); // EOF
    mockChild.exitCode = exitCode;
    mockChild.emit("exit", exitCode, null);
  }, 10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawnCopilot", () => {
  it("parses JSONL events and returns transcript", async () => {
    const lines = [
      JSON.stringify({ type: "user.message", data: { content: "test prompt" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "result text" } }),
      JSON.stringify({ type: "result", sessionId: "sess_1", timestamp: "2026-04-16T10:30:46.456Z" }),
    ];
    emitLines(lines, 0);

    const result = await spawnCopilot({
      runId: "test-run-001",
      promptText: "test prompt",
      cwd: tempDir,
      agentBaseDir: tempDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.transcript).toHaveLength(3);
    expect(result.finalAssistantText).toBe("result text");
  });

  it("captures the last assistant.message as finalAssistantText", async () => {
    const lines = [
      JSON.stringify({ type: "assistant.message", data: { content: "first" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "second" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "final answer" } }),
      JSON.stringify({ type: "result", sessionId: "sess_1" }),
    ];
    emitLines(lines, 0);

    const result = await spawnCopilot({
      runId: "test-run-002",
      promptText: "test",
      cwd: tempDir,
      agentBaseDir: tempDir,
    });

    expect(result.finalAssistantText).toBe("final answer");
  });

  it("spawns copilot with the pinned model and allow-all-tools flag", async () => {
    const lines = [
      JSON.stringify({ type: "assistant.message", data: { content: "ok" } }),
      JSON.stringify({ type: "result", sessionId: "sess_1" }),
    ];
    emitLines(lines, 0);

    await spawnCopilot({
      runId: "test-run-002a",
      promptText: "test",
      cwd: tempDir,
      agentBaseDir: tempDir,
    });

    const argv = spawnMock.mock.calls.at(-1)?.[1] as string[] | undefined;
    expect(argv).toBeDefined();
    expect(argv).toEqual(
      expect.arrayContaining([
        "--model=claude-haiku-4.5",
        "--allow-all-tools",
      ]),
    );
    expect(argv).not.toContain("--allow-all");
  });

  it("accumulates assistant.message_delta as fallback for finalAssistantText", async () => {
    const lines = [
      JSON.stringify({ type: "assistant.message", data: { content: "" } }),
      JSON.stringify({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "Hello" } }),
      JSON.stringify({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: " world" } }),
      JSON.stringify({ type: "result", sessionId: "sess_1" }),
    ];
    emitLines(lines, 0);

    const result = await spawnCopilot({
      runId: "test-run-002b",
      promptText: "test",
      cwd: tempDir,
      agentBaseDir: tempDir,
    });

    // No non-empty assistant.message, so fallback to accumulated deltas
    expect(result.finalAssistantText).toBe("Hello world");
  });

  it("publishes events to the EventBus", async () => {
    const bus = getEventBus();
    const sub = bus.subscribe({ runId: "test-run-003" });

    const lines = [
      JSON.stringify({ type: "assistant.message", data: { content: "hello" } }),
      JSON.stringify({ type: "result", sessionId: "sess_1" }),
    ];
    emitLines(lines, 0);

    const resultPromise = spawnCopilot({
      runId: "test-run-003",
      promptText: "test",
      cwd: tempDir,
      agentBaseDir: tempDir,
    });

    // Pull events from bus
    const event1 = await sub.waitForNext();
    expect(event1).not.toBeNull();
    expect(event1?.type).toBe("assistant.message");
    expect(event1?.channel).toBe("agent");

    await resultPromise;
    sub.close();
  });

  it("writes transcript.jsonl to the working directory", async () => {
    const lines = [
      JSON.stringify({ type: "assistant.message", data: { content: "hi" } }),
      JSON.stringify({ type: "result", sessionId: "sess_1" }),
    ];
    emitLines(lines, 0);

    await spawnCopilot({
      runId: "test-run-004",
      promptText: "test",
      cwd: tempDir,
      agentBaseDir: tempDir,
    });

    // Allow fire-and-forget appendFile calls to flush
    await new Promise((r) => setTimeout(r, 100));

    const transcriptContent = await readFile(
      path.join(tempDir, "transcript.jsonl"),
      "utf-8",
    );
    const transcriptLines = transcriptContent
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    expect(transcriptLines.length).toBeGreaterThanOrEqual(1);
  });

  it("returns non-zero exit code on process failure", async () => {
    emitLines([], 1);

    const result = await spawnCopilot({
      runId: "test-run-005",
      promptText: "test",
      cwd: tempDir,
      agentBaseDir: tempDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.transcript).toHaveLength(0);
  });

  it("escalates from SIGTERM to SIGKILL when a timed-out process stays alive", async () => {
    vi.useFakeTimers();

    const resultPromise = spawnCopilot({
      runId: "test-run-005b",
      promptText: "test",
      cwd: tempDir,
      agentBaseDir: tempDir,
      timeoutMs: 10,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(mockChild.killCalls).toContain("SIGTERM");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockChild.killCalls).toContain("SIGKILL");

    mockChild.stdout.push(null);
    mockChild.exitCode = 1;
    mockChild.emit("exit", 1, null);

    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
  });

  it("throws when COPILOT_GITHUB_TOKEN is missing", async () => {
    delete process.env["COPILOT_GITHUB_TOKEN"];

    await expect(
      spawnCopilot({
        runId: "test-run-006",
        promptText: "test",
        cwd: tempDir,
        agentBaseDir: tempDir,
      }),
    ).rejects.toThrow("COPILOT_GITHUB_TOKEN");
  });

  it("handles raw (non-JSON) lines without crashing", async () => {
    const lines = [
      "Some ANSI garbage output",
      JSON.stringify({ type: "assistant.message", data: { content: "ok" } }),
      "More garbage",
      JSON.stringify({ type: "result", sessionId: "sess_1" }),
    ];
    emitLines(lines, 0);

    const result = await spawnCopilot({
      runId: "test-run-007",
      promptText: "test",
      cwd: tempDir,
      agentBaseDir: tempDir,
    });

    expect(result.exitCode).toBe(0);
    // 2 raw + 2 typed = 4 events
    expect(result.transcript).toHaveLength(4);
    expect(result.finalAssistantText).toBe("ok");
  });

  it("captures tool.execution_complete results in toolResultTexts", async () => {
    const toolResult = { stdout: '{"decal_number":"LBP4255","serial_number":"S1"}', exitCode: 0 };
    const lines = [
      JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "tc-1", success: true, result: toolResult },
      }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "I wrote the JSON to a file." },
      }),
      JSON.stringify({ type: "result", sessionId: "sess_1" }),
    ];
    emitLines(lines, 0);

    const result = await spawnCopilot({
      runId: "test-run-008",
      promptText: "test",
      cwd: tempDir,
      agentBaseDir: tempDir,
    });

    expect(result.toolResultTexts).toHaveLength(1);
    expect(result.toolResultTexts[0]).toContain("LBP4255");
    expect(result.finalAssistantText).toBe("I wrote the JSON to a file.");
  });

  it("returns empty toolResultTexts when no tool calls occur", async () => {
    const lines = [
      JSON.stringify({ type: "assistant.message", data: { content: '{"ok":true}' } }),
      JSON.stringify({ type: "result", sessionId: "sess_1" }),
    ];
    emitLines(lines, 0);

    const result = await spawnCopilot({
      runId: "test-run-009",
      promptText: "test",
      cwd: tempDir,
      agentBaseDir: tempDir,
    });

    expect(result.toolResultTexts).toHaveLength(0);
    expect(result.finalAssistantText).toBe('{"ok":true}');
  });
});
