/**
 * Unit tests for src/lib/runs/stateMachine.ts
 *
 * Tests the pure transition table (not the async orchestrator).
 * Mocks the store and eventbus to isolate the transition logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("@/lib/runs/store", () => ({
  getRun: vi.fn(),
  updateRun: vi.fn(),
}));

vi.mock("@/lib/eventbus", () => {
  const publishMock = vi.fn().mockReturnValue({
    id: "mock-id",
    seq: 1,
    ts: new Date().toISOString(),
    channel: "run",
    type: "run.test",
  });
  return {
    getEventBus: () => ({ publish: publishMock }),
    __publishMock: publishMock,
  };
});

// Import after mocks are set up
import { transition, failRun, extractJsonFromText, resolveExtractedJson } from "@/lib/runs/stateMachine";
import { updateRun } from "@/lib/runs/store";
import type { RunStatus } from "@/lib/runs/store";

// Access the mock
const eventbusMod = await import("@/lib/eventbus");
const publishMock = (eventbusMod as unknown as { __publishMock: ReturnType<typeof vi.fn> })
  .__publishMock;

describe("stateMachine — transition()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const legalTransitions: [RunStatus, RunStatus][] = [
    ["ingested", "extracting"],
    ["ingested", "failed"],
    ["extracting", "awaiting_human"],
    ["extracting", "failed"],
    ["awaiting_human", "filling"],
    ["awaiting_human", "failed"],
    ["filling", "zipping"],
    ["filling", "failed"],
    ["zipping", "done"],
    ["zipping", "failed"],
  ];

  it.each(legalTransitions)(
    "allows %s → %s",
    (from, to) => {
      expect(() => transition("run-1", from, to)).not.toThrow();
      expect(updateRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: to }));
      expect(publishMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "run",
          type: `run.${to}`,
          runId: "run-1",
        }),
      );
    },
  );

  const illegalTransitions: [RunStatus, RunStatus][] = [
    ["done", "extracting"],
    ["done", "failed"],
    ["failed", "extracting"],
    ["failed", "done"],
    ["extracting", "done"],
    ["ingested", "filling"],
    ["awaiting_human", "zipping"],
  ];

  it.each(illegalTransitions)(
    "rejects %s → %s",
    (from, to) => {
      expect(() => transition("run-2", from, to)).toThrow(/Illegal transition/);
    },
  );

  it("passes extra fields to updateRun", () => {
    transition("run-3", "extracting", "awaiting_human", {
      extracted_json: '{"test":true}',
    });
    expect(updateRun).toHaveBeenCalledWith("run-3", {
      status: "awaiting_human",
      extracted_json: '{"test":true}',
    });
  });
});

describe("stateMachine — failRun()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions to failed from a non-terminal state", () => {
    failRun("run-4", "extracting", "Something went wrong");
    expect(updateRun).toHaveBeenCalledWith("run-4", {
      status: "failed",
      error: "Something went wrong",
    });
  });

  it("is a no-op from done state", () => {
    failRun("run-5", "done", "Should not transition");
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("is a no-op from failed state", () => {
    failRun("run-6", "failed", "Already failed");
    expect(updateRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// extractJsonFromText — LLM output parsing
// ---------------------------------------------------------------------------

describe("stateMachine — extractJsonFromText()", () => {
  it("parses pure JSON string", () => {
    const result = extractJsonFromText('{"decal_number":"LAA123"}');
    expect(result).toEqual({ decal_number: "LAA123" });
  });

  it("extracts JSON from markdown code fence (```json)", () => {
    const text = 'Here is the result:\n```json\n{"serial_number":"S999"}\n```\nDone.';
    const result = extractJsonFromText(text);
    expect(result).toEqual({ serial_number: "S999" });
  });

  it("extracts JSON from markdown code fence (``` without json tag)", () => {
    const text = 'Output:\n```\n{"owners":[{"name":"Jane"}]}\n```';
    const result = extractJsonFromText(text);
    expect(result).toEqual({ owners: [{ name: "Jane" }] });
  });

  it("extracts JSON from prose with braces", () => {
    const text = 'I extracted the following: {"decal_number":"LAA444","serial_number":"SN001"} which seems correct.';
    const result = extractJsonFromText(text);
    expect(result).toEqual({ decal_number: "LAA444", serial_number: "SN001" });
  });

  it("throws on text with no JSON at all", () => {
    expect(() => extractJsonFromText("No JSON here, sorry!")).toThrow(
      /No valid JSON object found/,
    );
  });

  it("throws on empty string", () => {
    expect(() => extractJsonFromText("")).toThrow(/No valid JSON object found/);
  });

  it("handles nested JSON objects", () => {
    const text = '```json\n{"owners":[{"name":"A","city":"LA"},{"name":"B"}]}\n```';
    const result = extractJsonFromText(text) as { owners: Array<{ name: string }> };
    expect(result.owners).toHaveLength(2);
    expect(result.owners[0]!.name).toBe("A");
  });

  it("handles JSON with unicode characters", () => {
    const text = '{"name":"José García","city":"São Paulo"}';
    const result = extractJsonFromText(text) as { name: string };
    expect(result.name).toBe("José García");
  });

  it("prefers direct parse over fence extraction", () => {
    // Valid JSON that happens to contain backticks in a string
    const text = '{"note":"use ```code``` blocks"}';
    const result = extractJsonFromText(text) as { note: string };
    expect(result.note).toBe("use ```code``` blocks");
  });
});

// ---------------------------------------------------------------------------
// resolveExtractedJson — multi-strategy JSON resolution
// ---------------------------------------------------------------------------

describe("stateMachine — resolveExtractedJson()", () => {
  // Helper to build a minimal SpawnCopilotResult
  function makeResult(overrides: {
    finalAssistantText?: string;
    toolResultTexts?: string[];
  }) {
    return {
      exitCode: 0,
      transcript: [],
      finalAssistantText: overrides.finalAssistantText ?? "",
      toolResultTexts: overrides.toolResultTexts ?? [],
    };
  }

  it("resolves JSON from finalAssistantText (strategy 1)", () => {
    const result = makeResult({
      finalAssistantText: '{"decal_number":"LBP4255"}',
    });
    const parsed = resolveExtractedJson(result, "/nonexistent");
    expect(parsed).toEqual({ decal_number: "LBP4255" });
  });

  it("resolves JSON from finalAssistantText with markdown fences", () => {
    const result = makeResult({
      finalAssistantText: 'Here:\n```json\n{"serial_number":"S1"}\n```\nDone.',
    });
    const parsed = resolveExtractedJson(result, "/nonexistent");
    expect(parsed).toEqual({ serial_number: "S1" });
  });

  it("falls through to tool results when finalAssistantText is prose (strategy 3)", () => {
    const result = makeResult({
      finalAssistantText: "I have extracted the data successfully!",
      toolResultTexts: [
        JSON.stringify({ stdout: "command output", exitCode: 0 }),
        JSON.stringify({ stdout: '{"decal_number":"LBP9999"}', exitCode: 0 }),
      ],
    });
    // No output.json on disk, falls through strategy 2 to strategy 3
    const parsed = resolveExtractedJson(result, "/nonexistent");
    // Tool results are stringified objects — extractJsonFromText finds JSON in them
    expect(parsed).toBeTruthy();
  });

  it("returns null when all strategies are exhausted", () => {
    const result = makeResult({
      finalAssistantText: "No JSON here at all!",
      toolResultTexts: ["not json either"],
    });
    const parsed = resolveExtractedJson(result, "/nonexistent");
    expect(parsed).toBeNull();
  });

  it("returns null on empty finalAssistantText and no tool results", () => {
    const result = makeResult({});
    const parsed = resolveExtractedJson(result, "/nonexistent");
    expect(parsed).toBeNull();
  });

  it("prefers strategy 1 over strategy 3 even when both have JSON", () => {
    const result = makeResult({
      finalAssistantText: '{"source":"message"}',
      toolResultTexts: [JSON.stringify({ source: "tool" })],
    });
    const parsed = resolveExtractedJson(result, "/nonexistent") as { source: string };
    expect(parsed.source).toBe("message");
  });
});
