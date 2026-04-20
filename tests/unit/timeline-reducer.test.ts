/**
 * Unit tests for src/lib/timeline-reducer.ts
 *
 * Coverage:
 *   - ADD_THINKING: new node creation, consecutive merging/grouping
 *   - ADD_TOOL_START: new tool node, auto-completes running thinking
 *   - UPDATE_TOOL_COMPLETE: paired event merge, success/failure status
 *   - ADD_STATUS: milestone creation, run.failed → "failed" status
 *   - ADD_HITL: HITL node creation with waiting status
 *   - ADD_PRODUCING: producing node creation with download URL
 *   - RESET: clears all state
 *   - Edge cases: orphan tool complete, duplicate tool IDs, empty state ops
 *   - Full pipeline simulation: extract → HITL → fill → zip → done
 */

import { describe, it, expect } from "vitest";
import {
  timelineReducer,
  completeRunningThinking,
  INITIAL_TIMELINE_STATE,
  type TimelineState,
  type TimelineAction,
  type ThinkingNode,
  type ToolCallNode,
  type StatusNode,
  type TimelineNode,
  type NodeStatus,
} from "@/lib/timeline-reducer";

const T = 1000; // base timestamp for readability

/** Helper: assert node at index exists and return it typed by kind. */
function nodeAt<K extends TimelineNode["kind"]>(
  nodes: TimelineNode[],
  idx: number,
  kind: K,
): Extract<TimelineNode, { kind: K }> {
  const node = nodes[idx];
  expect(node).toBeDefined();
  expect(node!.kind).toBe(kind);
  return node as Extract<TimelineNode, { kind: K }>;
}

describe("timelineReducer", () => {
  // ---- ADD_THINKING -------------------------------------------------------

  describe("ADD_THINKING", () => {
    it("creates a new ThinkingNode on empty state", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "Analyzing the PDF",
        timestamp: T,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.status).toBe("running");
      expect(node.content).toBe("Analyzing the PDF");
      expect(node.isGrouped).toBe(false);
      expect(node.startedAt).toBe(T);
      expect(node.completedAt).toBeUndefined();
    });

    it("merges consecutive thinking events into same node", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "First thought",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n2",
        content: "Second thought",
        timestamp: T + 100,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.content).toBe("First thought\nSecond thought");
      expect(node.isGrouped).toBe(true);
      expect(node.status).toBe("running");
    });

    it("creates new node after completed thinking", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "First batch",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.extracting",
        label: "Extracting",
        timestamp: T + 500,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n2",
        content: "New batch",
        timestamp: T + 600,
      });

      expect(state.nodes).toHaveLength(3);
      const first = nodeAt(state.nodes, 0, "thinking");
      expect(first.status).toBe("completed");
      nodeAt(state.nodes, 1, "status");
      const second = nodeAt(state.nodes, 2, "thinking");
      expect(second.content).toBe("New batch");
      expect(second.status).toBe("running");
    });

    it("does not merge into a completed ThinkingNode", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "Thought A",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T + 200,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n2",
        content: "Thought B",
        timestamp: T + 300,
      });

      expect(state.nodes).toHaveLength(3);
      const a = nodeAt(state.nodes, 0, "thinking");
      expect(a.content).toBe("Thought A");
      const b = nodeAt(state.nodes, 2, "thinking");
      expect(b.content).toBe("Thought B");
    });

    it("merges three consecutive thinking events", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "Step 1",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n2",
        content: "Step 2",
        timestamp: T + 50,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n3",
        content: "Step 3",
        timestamp: T + 100,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.content).toBe("Step 1\nStep 2\nStep 3");
      expect(node.isGrouped).toBe(true);
    });
  });

  // ---- ADD_TOOL_START -----------------------------------------------------

  describe("ADD_TOOL_START", () => {
    it("creates a running ToolCallNode", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "extract_form_data",
        serverName: "mcp-pdf",
        args: { file: "/workspace/runs/test/title.pdf" },
        timestamp: T,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.status).toBe("running");
      expect(node.toolCallId).toBe("tc-1");
      expect(node.toolName).toBe("extract_form_data");
      expect(node.serverName).toBe("mcp-pdf");
      expect(node.args).toEqual({ file: "/workspace/runs/test/title.pdf" });
      expect(state.toolCallIdMap["tc-1"]).toBe(0);
    });

    it("auto-completes running thinking when tool starts", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "I will extract...",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T + 100,
      });

      expect(state.nodes).toHaveLength(2);
      const thinking = nodeAt(state.nodes, 0, "thinking");
      expect(thinking.status).toBe("completed");
      expect(thinking.completedAt).toBe(T + 100);
    });

    it("tracks multiple tool calls in toolCallIdMap", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t2",
        toolCallId: "tc-2",
        toolName: "fill_form_pdf",
        serverName: "mcp-pdf",
        timestamp: T + 100,
      });

      expect(state.toolCallIdMap["tc-1"]).toBe(0);
      expect(state.toolCallIdMap["tc-2"]).toBe(1);
      expect(state.nodes).toHaveLength(2);
    });

    it("creates tool without args", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "convert_pdf",
        serverName: "pymupdf4llm",
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.args).toBeUndefined();
    });
  });

  // ---- UPDATE_TOOL_COMPLETE -----------------------------------------------

  describe("UPDATE_TOOL_COMPLETE", () => {
    it("pairs with matching tool start → completed status", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-1",
        result: { text: "extracted data" },
        timestamp: T + 2000,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.status).toBe("completed");
      expect(node.completedAt).toBe(T + 2000);
      expect(node.result).toEqual({ text: "extracted data" });
      expect(node.error).toBeUndefined();
    });

    it("sets failed status when error is provided", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-1",
        error: "File not found",
        timestamp: T + 500,
      });

      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.status).toBe("failed");
      expect(node.error).toBe("File not found");
      expect(node.result).toBeUndefined();
    });

    it("ignores orphan tool complete with unknown toolCallId", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-nonexistent",
        result: { data: "orphan" },
        timestamp: T,
      });

      expect(state.nodes).toHaveLength(0);
      expect(state).toBe(INITIAL_TIMELINE_STATE);
    });

    it("ignores tool complete if mapped index is not a tool node", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "thinking",
        timestamp: T,
      });
      // Force a bad map entry pointing to the thinking node
      state = { ...state, toolCallIdMap: { "tc-bad": 0 } };

      const result = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-bad",
        result: {},
        timestamp: T + 100,
      });

      expect(result).toBe(state);
    });

    it("updates correct tool when multiple are in flight", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t2",
        toolCallId: "tc-2",
        toolName: "fill_form_pdf",
        serverName: "mcp-pdf",
        timestamp: T + 100,
      });
      // Complete second tool first (out of order)
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-2",
        result: { done: true },
        timestamp: T + 500,
      });

      const tool1 = nodeAt(state.nodes, 0, "tool");
      expect(tool1.status).toBe("running");

      const tool2 = nodeAt(state.nodes, 1, "tool");
      expect(tool2.status).toBe("completed");
      expect(tool2.result).toEqual({ done: true });
    });
  });

  // ---- ADD_STATUS ---------------------------------------------------------

  describe("ADD_STATUS", () => {
    it("creates a StatusNode with completed status", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.ingested",
        label: "Run Started",
        timestamp: T,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "status");
      expect(node.status).toBe("completed");
      expect(node.eventType).toBe("run.ingested");
      expect(node.label).toBe("Run Started");
    });

    it("sets failed status for run.failed event", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.failed",
        label: "Run Failed",
        detail: "Copilot timeout",
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "status");
      expect(node.status).toBe("failed");
      expect(node.detail).toBe("Copilot timeout");
    });

    it("auto-completes running thinking before status", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "reasoning",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "extract.done",
        label: "Extraction Complete",
        timestamp: T + 500,
      });

      expect(state.nodes).toHaveLength(2);
      const thinking = nodeAt(state.nodes, 0, "thinking");
      expect(thinking.status).toBe("completed");
      expect(thinking.completedAt).toBe(T + 500);
    });
  });

  // ---- ADD_HITL -----------------------------------------------------------

  describe("ADD_HITL", () => {
    it("creates an HitlNode with waiting status", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-123",
        fieldCount: 24,
        timestamp: T,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "hitl");
      expect(node.status).toBe("waiting");
      expect(node.runId).toBe("run-123");
      expect(node.fieldCount).toBe(24);
    });

    it("auto-completes running thinking before HITL", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "analyzing fields",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-123",
        timestamp: T + 300,
      });

      const thinking = nodeAt(state.nodes, 0, "thinking");
      expect(thinking.status).toBe("completed");
    });

    it("creates HITL without fieldCount", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-456",
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "hitl");
      expect(node.fieldCount).toBeUndefined();
    });
  });

  // ---- ADD_PRODUCING ------------------------------------------------------

  describe("ADD_PRODUCING", () => {
    it("creates a ProducingNode with download URL", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_PRODUCING",
        id: "p1",
        eventType: "zip.ready",
        runId: "run-123",
        downloadUrl: "/api/runs/run-123/download",
        timestamp: T,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "producing");
      expect(node.status).toBe("completed");
      expect(node.downloadUrl).toBe("/api/runs/run-123/download");
      expect(node.runId).toBe("run-123");
      expect(node.eventType).toBe("zip.ready");
    });

    it("auto-completes running thinking before producing", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "finalizing",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_PRODUCING",
        id: "p1",
        eventType: "zip.ready",
        runId: "run-1",
        downloadUrl: "/download",
        timestamp: T + 100,
      });

      const thinking = nodeAt(state.nodes, 0, "thinking");
      expect(thinking.status).toBe("completed");
    });
  });

  // ---- RESET --------------------------------------------------------------

  describe("RESET", () => {
    it("clears all nodes and toolCallIdMap", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "test",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "test_tool",
        serverName: "test-server",
        timestamp: T + 100,
      });

      expect(state.nodes).toHaveLength(2);

      const reset = timelineReducer(state, { type: "RESET" });
      expect(reset.nodes).toHaveLength(0);
      expect(reset.toolCallIdMap).toEqual({});
    });
  });

  // ---- Unknown action type ------------------------------------------------

  describe("unknown action", () => {
    it("returns state unchanged for unknown action type", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "RESET",
      });
      // @ts-expect-error — testing runtime safety with invalid action
      const result = timelineReducer(state, { type: "UNKNOWN_ACTION" });
      expect(result).toBe(state);
    });
  });

  // ---- Full pipeline simulation -------------------------------------------

  describe("full pipeline simulation", () => {
    it("simulates a complete extract → HITL → fill → zip pipeline", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      // 1. Run ingested
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.ingested",
        label: "Run Started",
        timestamp: T,
      });

      // 2. Agent starts thinking (consecutive → merged)
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n1",
        content: "I need to extract data from the title PDF.",
        timestamp: T + 100,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n2",
        content: "I will use extract_form_data.",
        timestamp: T + 200,
      });

      // 3. Tool call start (auto-completes thinking)
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-extract",
        toolName: "extract_form_data",
        serverName: "mcp-pdf",
        args: { file: "/workspace/runs/test/title.pdf" },
        timestamp: T + 300,
      });

      // 4. Tool call complete (pairs with start)
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-extract",
        result: { decal_number: "A123456" },
        timestamp: T + 2300,
      });

      // 5. Extraction done milestone
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s2",
        eventType: "extract.done",
        label: "Extraction Complete",
        timestamp: T + 2400,
      });

      // 6. HITL pause
      state = timelineReducer(state, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-test",
        fieldCount: 24,
        timestamp: T + 2500,
      });

      // 7. Filling milestone
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s3",
        eventType: "run.filling",
        label: "Filling Forms…",
        timestamp: T + 5000,
      });

      // 8. Fill tool (start + complete)
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t2",
        toolCallId: "tc-fill",
        toolName: "fill_form_pdf",
        serverName: "mcp-pdf",
        args: { template: "HCD_476.6G.pdf" },
        timestamp: T + 5100,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-fill",
        result: { path: "/workspace/runs/test/filled/HCD_476.6G.pdf" },
        timestamp: T + 8000,
      });

      // 9. ZIP ready (producing)
      state = timelineReducer(state, {
        type: "ADD_PRODUCING",
        id: "p1",
        eventType: "zip.ready",
        runId: "run-test",
        downloadUrl: "/api/runs/run-test/download",
        timestamp: T + 9000,
      });

      // 10. Run done
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s4",
        eventType: "run.done",
        label: "Run Complete",
        timestamp: T + 9100,
      });

      // ---- Verify full timeline structure ----
      expect(state.nodes).toHaveLength(9);

      // Node 0: StatusNode (run.ingested)
      nodeAt(state.nodes, 0, "status");

      // Node 1: ThinkingNode (grouped, auto-completed by tool start)
      const thinking = nodeAt(state.nodes, 1, "thinking");
      expect(thinking.isGrouped).toBe(true);
      expect(thinking.status).toBe("completed");
      expect(thinking.content).toContain("extract data");
      expect(thinking.content).toContain("extract_form_data");

      // Node 2: ToolCallNode (extract_form_data, completed via pairing)
      const extractTool = nodeAt(state.nodes, 2, "tool");
      expect(extractTool.status).toBe("completed");
      expect(extractTool.toolName).toBe("extract_form_data");
      expect(extractTool.result).toEqual({ decal_number: "A123456" });

      // Node 3: StatusNode (extract.done)
      nodeAt(state.nodes, 3, "status");

      // Node 4: HitlNode (completed — auto-completed when run.filling arrived)
      const hitl = nodeAt(state.nodes, 4, "hitl");
      expect(hitl.status).toBe("completed");
      expect(hitl.fieldCount).toBe(24);

      // Node 5: StatusNode (run.filling)
      nodeAt(state.nodes, 5, "status");

      // Node 6: ToolCallNode (fill_form_pdf, completed)
      const fillTool = nodeAt(state.nodes, 6, "tool");
      expect(fillTool.status).toBe("completed");
      expect(fillTool.toolName).toBe("fill_form_pdf");

      // Node 7: ProducingNode (zip.ready)
      const producing = nodeAt(state.nodes, 7, "producing");
      expect(producing.downloadUrl).toBe("/api/runs/run-test/download");

      // Node 8: StatusNode (run.done)
      const done = nodeAt(state.nodes, 8, "status");
      expect(done.eventType).toBe("run.done");
    });

    it("handles failed pipeline with error propagation", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.ingested",
        label: "Run Started",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T + 100,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-1",
        error: "PDF corrupted",
        timestamp: T + 200,
      });
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s2",
        eventType: "run.failed",
        label: "Run Failed",
        detail: "Extraction failed: PDF corrupted",
        timestamp: T + 300,
      });

      expect(state.nodes).toHaveLength(3);

      const failedTool = nodeAt(state.nodes, 1, "tool");
      expect(failedTool.status).toBe("failed");
      expect(failedTool.error).toBe("PDF corrupted");

      const failedStatus = nodeAt(state.nodes, 2, "status");
      expect(failedStatus.status).toBe("failed");
      expect(failedStatus.detail).toBe("Extraction failed: PDF corrupted");
    });

    it("handles rapid consecutive events correctly", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      // Rapid-fire: thinking → thinking → tool → tool complete → thinking → status
      state = timelineReducer(state, {
        type: "ADD_THINKING", id: "n1", content: "A", timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING", id: "n2", content: "B", timestamp: T + 1,
      });
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t1", toolCallId: "tc-1", toolName: "test",
        serverName: "s", timestamp: T + 2,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-1", result: {}, timestamp: T + 3,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING", id: "n3", content: "C", timestamp: T + 4,
      });
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s1", eventType: "run.done", label: "Done", timestamp: T + 5,
      });

      expect(state.nodes).toHaveLength(4);
      // Node 0: thinking (A+B merged, completed by tool start)
      const t0 = nodeAt(state.nodes, 0, "thinking");
      expect(t0.content).toBe("A\nB");
      expect(t0.status).toBe("completed");
      // Node 1: tool (completed)
      expect(nodeAt(state.nodes, 1, "tool").status).toBe("completed");
      // Node 2: thinking (C, completed by status)
      const t2 = nodeAt(state.nodes, 2, "thinking");
      expect(t2.content).toBe("C");
      expect(t2.status).toBe("completed");
      // Node 3: status (run.done)
      nodeAt(state.nodes, 3, "status");
    });
  });
});

// ---- completeRunningThinking helper tests ---------------------------------

describe("completeRunningThinking", () => {
  it("returns same array if empty", () => {
    const nodes: TimelineNode[] = [];
    const result = completeRunningThinking(nodes, T);
    expect(result).toBe(nodes);
  });

  it("returns same array if last node is not thinking", () => {
    const nodes: TimelineNode[] = [
      {
        id: "s1",
        kind: "status",
        status: "completed",
        startedAt: T,
        completedAt: T,
        eventType: "run.ingested",
        label: "Run Started",
      },
    ];
    const result = completeRunningThinking(nodes, T + 100);
    expect(result).toBe(nodes);
  });

  it("returns same array if last thinking is already completed", () => {
    const nodes: TimelineNode[] = [
      {
        id: "n1",
        kind: "thinking",
        status: "completed",
        startedAt: T,
        completedAt: T + 50,
        content: "done",
        isGrouped: false,
      },
    ];
    const result = completeRunningThinking(nodes, T + 100);
    expect(result).toBe(nodes);
  });

  it("completes running thinking node at tail", () => {
    const nodes: TimelineNode[] = [
      {
        id: "n1",
        kind: "thinking",
        status: "running",
        startedAt: T,
        content: "in progress",
        isGrouped: false,
      },
    ];
    const result = completeRunningThinking(nodes, T + 200);

    expect(result).not.toBe(nodes);
    expect(result).toHaveLength(1);
    const completed = result[0] as ThinkingNode;
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe(T + 200);
  });

  it("does not modify non-tail thinking nodes", () => {
    const nodes: TimelineNode[] = [
      {
        id: "n1",
        kind: "thinking",
        status: "running",
        startedAt: T,
        content: "first",
        isGrouped: false,
      },
      {
        id: "s1",
        kind: "status",
        status: "completed",
        startedAt: T + 50,
        completedAt: T + 50,
        eventType: "run.ingested",
        label: "Run Started",
      },
    ];
    const result = completeRunningThinking(nodes, T + 100);
    // Last node is status, not thinking — no change
    expect(result).toBe(nodes);
  });
});

// ===========================================================================
// P7.8 — ENHANCED STRESS & EDGE CASE TESTS
// Adversarial inputs, high-volume sequences, interleaved patterns, boundary
// conditions, and reducer determinism under pressure.
// ===========================================================================

describe("P7.8 — timeline reducer stress & edge cases", () => {
  // ---- High-volume thinking merge stress ----------------------------------

  describe("high-volume thinking merge", () => {
    it("merges 100 consecutive thinking events into a single node", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;
      for (let i = 0; i < 100; i++) {
        state = timelineReducer(state, {
          type: "ADD_THINKING",
          id: `n${i}`,
          content: `Thought ${i}`,
          timestamp: T + i,
        });
      }

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.isGrouped).toBe(true);
      expect(node.status).toBe("running");
      const lines = node.content.split("\n").filter(Boolean);
      expect(lines).toHaveLength(100);
      expect(lines[0]).toBe("Thought 0");
      expect(lines[99]).toBe("Thought 99");
    });

    it("handles 500-event mixed pipeline without corruption", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;
      const toolIds: string[] = [];

      for (let i = 0; i < 100; i++) {
        // Think → Tool Start → Tool Complete → Status cycle
        state = timelineReducer(state, {
          type: "ADD_THINKING",
          id: `n${i}`,
          content: `Analyzing step ${i}`,
          timestamp: T + i * 5,
        });
        const tcId = `tc-${i}`;
        toolIds.push(tcId);
        state = timelineReducer(state, {
          type: "ADD_TOOL_START",
          id: `t${i}`,
          toolCallId: tcId,
          toolName: "extract_text",
          serverName: "mcp-pdf",
          timestamp: T + i * 5 + 1,
        });
        state = timelineReducer(state, {
          type: "UPDATE_TOOL_COMPLETE",
          toolCallId: tcId,
          result: { step: i },
          timestamp: T + i * 5 + 2,
        });
        state = timelineReducer(state, {
          type: "ADD_STATUS",
          id: `s${i}`,
          eventType: "extract.done",
          label: `Step ${i} done`,
          timestamp: T + i * 5 + 3,
        });
      }

      // 100 thinking + 100 tool + 100 status = 300 nodes
      expect(state.nodes).toHaveLength(300);

      // All thinking nodes should be completed (auto-completed by tool start)
      const thinkingNodes = state.nodes.filter((n) => n.kind === "thinking");
      expect(thinkingNodes).toHaveLength(100);
      thinkingNodes.forEach((n) => expect(n.status).toBe("completed"));

      // All tool nodes should be completed
      const toolNodes = state.nodes.filter((n) => n.kind === "tool");
      expect(toolNodes).toHaveLength(100);
      toolNodes.forEach((n) => expect(n.status).toBe("completed"));

      // toolCallIdMap should have all 100 entries
      expect(Object.keys(state.toolCallIdMap)).toHaveLength(100);
    });
  });

  // ---- Interleaved tool execution patterns --------------------------------

  describe("interleaved tool execution", () => {
    it("handles 10 concurrent tools started then completed out of order", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      // Start all 10 tools
      for (let i = 0; i < 10; i++) {
        state = timelineReducer(state, {
          type: "ADD_TOOL_START",
          id: `t${i}`,
          toolCallId: `tc-${i}`,
          toolName: `tool_${i}`,
          serverName: "mcp-pdf",
          timestamp: T + i,
        });
      }

      expect(state.nodes).toHaveLength(10);
      state.nodes.forEach((n) => expect(n.status).toBe("running"));

      // Complete in reverse order
      for (let i = 9; i >= 0; i--) {
        state = timelineReducer(state, {
          type: "UPDATE_TOOL_COMPLETE",
          toolCallId: `tc-${i}`,
          result: { completed: i },
          timestamp: T + 20 - i,
        });
      }

      state.nodes.forEach((n) => {
        expect(n.status).toBe("completed");
        expect(n.kind).toBe("tool");
      });
    });

    it("handles mixed success/failure across concurrent tools", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      // Start 5 tools
      for (let i = 0; i < 5; i++) {
        state = timelineReducer(state, {
          type: "ADD_TOOL_START",
          id: `t${i}`,
          toolCallId: `tc-${i}`,
          toolName: `tool_${i}`,
          serverName: "mcp-pdf",
          timestamp: T + i,
        });
      }

      // Complete: even indices succeed, odd indices fail
      for (let i = 0; i < 5; i++) {
        state = timelineReducer(state, {
          type: "UPDATE_TOOL_COMPLETE",
          toolCallId: `tc-${i}`,
          result: i % 2 === 0 ? { ok: true } : undefined,
          error: i % 2 !== 0 ? `Error in tool ${i}` : undefined,
          timestamp: T + 10 + i,
        });
      }

      for (let i = 0; i < 5; i++) {
        const node = nodeAt(state.nodes, i, "tool");
        if (i % 2 === 0) {
          expect(node.status).toBe("completed");
          expect(node.error).toBeUndefined();
        } else {
          expect(node.status).toBe("failed");
          expect(node.error).toBe(`Error in tool ${i}`);
        }
      }
    });
  });

  // ---- Duplicate/repeated event resilience --------------------------------

  describe("duplicate and edge-case events", () => {
    it("duplicate tool complete for same toolCallId overwrites first result", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-dup",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T,
      });

      // First complete
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-dup",
        result: { first: true },
        timestamp: T + 100,
      });

      const after1 = nodeAt(state.nodes, 0, "tool");
      expect(after1.status).toBe("completed");
      expect(after1.result).toEqual({ first: true });

      // Second complete (duplicate) — should overwrite
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-dup",
        result: { second: true },
        timestamp: T + 200,
      });

      const after2 = nodeAt(state.nodes, 0, "tool");
      expect(after2.result).toEqual({ second: true });
      expect(after2.completedAt).toBe(T + 200);
    });

    it("tool start with same ID as existing tool creates separate node", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T,
      });
      // Another tool start with DIFFERENT toolCallId but same id
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-2",
        toolName: "fill_form_pdf",
        serverName: "mcp-pdf",
        timestamp: T + 100,
      });

      expect(state.nodes).toHaveLength(2);
      expect(state.toolCallIdMap["tc-1"]).toBe(0);
      expect(state.toolCallIdMap["tc-2"]).toBe(1);
    });

    it("RESET followed by new events produces clean state", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      // Build up some state
      state = timelineReducer(state, {
        type: "ADD_THINKING", id: "n1", content: "old", timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t1", toolCallId: "tc-1", toolName: "test",
        serverName: "s", timestamp: T + 1,
      });

      // Reset
      state = timelineReducer(state, { type: "RESET" });
      expect(state.nodes).toHaveLength(0);
      expect(state.toolCallIdMap).toEqual({});

      // Build new state
      state = timelineReducer(state, {
        type: "ADD_THINKING", id: "n2", content: "fresh", timestamp: T + 100,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.content).toBe("fresh");
      expect(node.id).toBe("n2");
    });
  });

  // ---- Boundary content values --------------------------------------------

  describe("boundary content values", () => {
    it("handles empty string content in thinking", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "",
        timestamp: T,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.content).toBe("");
    });

    it("handles very long content (10KB) in thinking", () => {
      const longContent = "X".repeat(10240);
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: longContent,
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.content).toHaveLength(10240);
    });

    it("handles unicode/emoji in thinking content", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "分析 PDF 📄 日本語テスト 🔥 Ñoño",
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.content).toContain("📄");
      expect(node.content).toContain("日本語");
    });

    it("handles special chars in tool args values", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-special",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        args: {
          path: "/workspace/runs/../../../etc/passwd",
          script: "<script>alert('xss')</script>",
          nullByte: "file\x00.pdf",
          newlines: "line1\nline2\rline3",
        },
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.args?.path).toBe("/workspace/runs/../../../etc/passwd");
      expect(node.args?.script).toBe("<script>alert('xss')</script>");
    });

    it("handles null/undefined result in tool complete", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-null",
        toolName: "test",
        serverName: "s",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-null",
        result: undefined,
        error: undefined,
        timestamp: T + 100,
      });

      const node = nodeAt(state.nodes, 0, "tool");
      // No error provided → completed status
      expect(node.status).toBe("completed");
      expect(node.result).toBeUndefined();
      expect(node.error).toBeUndefined();
    });

    it("handles deeply nested result objects in tool complete", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-deep",
        toolName: "test",
        serverName: "s",
        timestamp: T,
      });

      const deepResult = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: { data: Array.from({ length: 50 }, (_, i) => i) },
              },
            },
          },
        },
      };

      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-deep",
        result: deepResult,
        timestamp: T + 100,
      });

      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.status).toBe("completed");
      expect(
        (node.result as Record<string, unknown>)
      ).toEqual(deepResult);
    });

    it("handles status with empty/missing detail", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.failed",
        label: "Run Failed",
        detail: undefined,
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "status");
      expect(node.status).toBe("failed");
      expect(node.detail).toBeUndefined();
    });

    it("handles HITL with fieldCount of 0", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-zero",
        fieldCount: 0,
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "hitl");
      expect(node.fieldCount).toBe(0);
    });
  });

  // ---- Timestamp edge cases -----------------------------------------------

  describe("timestamp edge cases", () => {
    it("handles zero timestamp", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "epoch",
        timestamp: 0,
      });

      expect(nodeAt(state.nodes, 0, "thinking").startedAt).toBe(0);
    });

    it("handles very large timestamp (year 2100)", () => {
      const farFuture = new Date(2100, 0, 1).getTime();
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "future",
        timestamp: farFuture,
      });

      expect(nodeAt(state.nodes, 0, "thinking").startedAt).toBe(farFuture);
    });

    it("handles equal start and complete timestamps", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-instant",
        toolName: "test",
        serverName: "s",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-instant",
        result: {},
        timestamp: T, // same timestamp — zero-duration
      });

      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.status).toBe("completed");
      expect(node.startedAt).toBe(T);
      expect(node.completedAt).toBe(T);
    });
  });

  // ---- State immutability -------------------------------------------------

  describe("state immutability", () => {
    it("does not mutate previous state on ADD_THINKING", () => {
      const state1 = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "first",
        timestamp: T,
      });
      const nodesRef = state1.nodes;

      const state2 = timelineReducer(state1, {
        type: "ADD_THINKING",
        id: "n2",
        content: "second",
        timestamp: T + 1,
      });

      // state1 nodes array should be unchanged
      expect(nodesRef).toHaveLength(1);
      expect(state1.nodes).toHaveLength(1);
      // state2 is a merge, so still 1 node but different reference
      expect(state2.nodes).toHaveLength(1);
      expect(state2.nodes).not.toBe(state1.nodes);
    });

    it("does not mutate previous state on UPDATE_TOOL_COMPLETE", () => {
      const state1 = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "test",
        serverName: "s",
        timestamp: T,
      });
      const toolNodeBefore = state1.nodes[0]!;

      const state2 = timelineReducer(state1, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-1",
        result: { done: true },
        timestamp: T + 100,
      });

      // Original tool node should still be running
      expect(toolNodeBefore.status).toBe("running");
      expect(state2.nodes[0]!.status).toBe("completed");
    });

    it("INITIAL_TIMELINE_STATE is never mutated", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "test",
        timestamp: T,
      });
      const resetState = timelineReducer(state, { type: "RESET" });

      expect(INITIAL_TIMELINE_STATE.nodes).toHaveLength(0);
      expect(INITIAL_TIMELINE_STATE.toolCallIdMap).toEqual({});
      // Verify reset produced clean state
      expect(resetState.nodes).toHaveLength(0);
    });
  });

  // ---- Rapid interleaving pattern -----------------------------------------

  describe("rapid interleaving patterns", () => {
    it("alternating think-tool-think-tool 50 times produces correct structure", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      for (let i = 0; i < 50; i++) {
        state = timelineReducer(state, {
          type: "ADD_THINKING",
          id: `n${i}`,
          content: `Thinking about step ${i}`,
          timestamp: T + i * 3,
        });
        state = timelineReducer(state, {
          type: "ADD_TOOL_START",
          id: `t${i}`,
          toolCallId: `tc-${i}`,
          toolName: "test",
          serverName: "s",
          timestamp: T + i * 3 + 1,
        });
        state = timelineReducer(state, {
          type: "UPDATE_TOOL_COMPLETE",
          toolCallId: `tc-${i}`,
          result: {},
          timestamp: T + i * 3 + 2,
        });
      }

      // 50 thinking + 50 tool = 100 nodes
      expect(state.nodes).toHaveLength(100);

      // All thinking nodes should be auto-completed
      const thinking = state.nodes.filter((n) => n.kind === "thinking");
      expect(thinking).toHaveLength(50);
      thinking.forEach((n) => expect(n.status).toBe("completed"));

      // No thinking should be grouped (each interrupted by tool)
      thinking.forEach((n) => {
        expect((n as ThinkingNode).isGrouped).toBe(false);
      });
    });

    it("handles all 5 node kinds in rapid succession", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.ingested",
        label: "Run Started",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n1",
        content: "Analyzing",
        timestamp: T + 1,
      });
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T + 2,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-1",
        result: {},
        timestamp: T + 3,
      });
      state = timelineReducer(state, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-1",
        fieldCount: 10,
        timestamp: T + 4,
      });
      state = timelineReducer(state, {
        type: "ADD_PRODUCING",
        id: "p1",
        eventType: "zip.ready",
        runId: "run-1",
        downloadUrl: "/download",
        timestamp: T + 5,
      });
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s2",
        eventType: "run.done",
        label: "Run Complete",
        timestamp: T + 6,
      });

      expect(state.nodes).toHaveLength(6);
      expect(state.nodes[0]!.kind).toBe("status");
      expect(state.nodes[1]!.kind).toBe("thinking");
      expect(state.nodes[2]!.kind).toBe("tool");
      expect(state.nodes[3]!.kind).toBe("hitl");
      expect(state.nodes[4]!.kind).toBe("producing");
      expect(state.nodes[5]!.kind).toBe("status");

      // Thinking should have been auto-completed by tool start
      expect(state.nodes[1]!.status).toBe("completed");
    });
  });

  // ---- Reducer determinism ------------------------------------------------

  describe("reducer determinism", () => {
    it("same action sequence always produces identical state", () => {
      const actions = [
        { type: "ADD_THINKING" as const, id: "n1", content: "A", timestamp: T },
        { type: "ADD_THINKING" as const, id: "n2", content: "B", timestamp: T + 1 },
        {
          type: "ADD_TOOL_START" as const,
          id: "t1",
          toolCallId: "tc-1",
          toolName: "test",
          serverName: "s",
          timestamp: T + 2,
        },
        {
          type: "UPDATE_TOOL_COMPLETE" as const,
          toolCallId: "tc-1",
          result: { x: 42 },
          timestamp: T + 3,
        },
        {
          type: "ADD_STATUS" as const,
          id: "s1",
          eventType: "run.done",
          label: "Done",
          timestamp: T + 4,
        },
      ];

      let state1: TimelineState = INITIAL_TIMELINE_STATE;
      let state2: TimelineState = INITIAL_TIMELINE_STATE;

      for (const action of actions) {
        state1 = timelineReducer(state1, action);
        state2 = timelineReducer(state2, action);
      }

      expect(state1).toEqual(state2);
      expect(state1.nodes).toHaveLength(state2.nodes.length);
    });
  });

  // ---- HITL and Producing edge cases --------------------------------------

  describe("HITL and producing edge cases", () => {
    it("multiple HITL nodes in same timeline", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      state = timelineReducer(state, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-1",
        fieldCount: 10,
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_HITL",
        id: "h2",
        runId: "run-1",
        fieldCount: 20,
        timestamp: T + 100,
      });

      expect(state.nodes).toHaveLength(2);
      expect(nodeAt(state.nodes, 0, "hitl").fieldCount).toBe(10);
      expect(nodeAt(state.nodes, 1, "hitl").fieldCount).toBe(20);
      state.nodes.forEach((n) => expect(n.status).toBe("waiting"));
    });

    it("producing node preserves download URL with special characters", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_PRODUCING",
        id: "p1",
        eventType: "zip.ready",
        runId: "run-special",
        downloadUrl: "/api/runs/01KPMGDPHX%20K5/download?token=abc&v=2",
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "producing");
      expect(node.downloadUrl).toBe(
        "/api/runs/01KPMGDPHX%20K5/download?token=abc&v=2",
      );
    });
  });
});

// ===========================================================================
// P8v2 — ENHANCED ADVERSARIAL RE-SWEEP v2
// Adjusted details, added complexity, nuanced edge cases not covered in P7/P8.
// Covers: negative timestamps, NaN-like values, 1000+ node scale, toolCallIdMap
// drift after RESET, prototype pollution, cross-node-type merge isolation,
// run lifecycle completeness, reducer replay idempotency, and more.
// ===========================================================================

describe("P8v2 — enhanced adversarial re-sweep v2", () => {

  // ---- Negative & extreme timestamps --------------------------------------

  describe("negative and extreme timestamps", () => {
    it("handles negative timestamp without crashing", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "negative time",
        timestamp: -1000,
      });

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.startedAt).toBe(-1000);
    });

    it("handles Number.MAX_SAFE_INTEGER timestamp", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-max",
        toolName: "test",
        serverName: "s",
        timestamp: Number.MAX_SAFE_INTEGER,
      });

      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.startedAt).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("handles completedAt before startedAt (backwards time)", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-back",
        toolName: "test",
        serverName: "s",
        timestamp: T + 1000,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-back",
        result: { ok: true },
        timestamp: T, // before start — reducer doesn't enforce ordering
      });

      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.status).toBe("completed");
      expect(node.startedAt).toBe(T + 1000);
      expect(node.completedAt).toBe(T);
    });
  });

  // ---- Scale: 1000+ nodes -------------------------------------------------

  describe("scale: 1000+ node stress test", () => {
    it("handles 1000-event pipeline with correct node count and indexing", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      // 200 cycles of: status → thinking → tool start → tool complete → status
      for (let i = 0; i < 200; i++) {
        state = timelineReducer(state, {
          type: "ADD_STATUS",
          id: `s-start-${i}`,
          eventType: "run.extracting",
          label: `Extracting ${i}`,
          timestamp: T + i * 5,
        });
        state = timelineReducer(state, {
          type: "ADD_THINKING",
          id: `n${i}`,
          content: `Analyzing iteration ${i}`,
          timestamp: T + i * 5 + 1,
        });
        state = timelineReducer(state, {
          type: "ADD_TOOL_START",
          id: `t${i}`,
          toolCallId: `tc-${i}`,
          toolName: `tool_${i}`,
          serverName: "mcp-pdf",
          timestamp: T + i * 5 + 2,
        });
        state = timelineReducer(state, {
          type: "UPDATE_TOOL_COMPLETE",
          toolCallId: `tc-${i}`,
          result: { iteration: i },
          timestamp: T + i * 5 + 3,
        });
        state = timelineReducer(state, {
          type: "ADD_STATUS",
          id: `s-done-${i}`,
          eventType: "extract.done",
          label: `Done ${i}`,
          timestamp: T + i * 5 + 4,
        });
      }

      // 200 * (status + thinking + tool + status) = 800 nodes (tool complete updates existing)
      expect(state.nodes).toHaveLength(800);
      expect(Object.keys(state.toolCallIdMap)).toHaveLength(200);

      // Verify first and last tool nodes are correct
      const firstTool = state.nodes.find(
        (n) => n.kind === "tool" && (n as ToolCallNode).toolCallId === "tc-0",
      ) as ToolCallNode;
      expect(firstTool.status).toBe("completed");
      expect(firstTool.result).toEqual({ iteration: 0 });

      const lastTool = state.nodes.find(
        (n) => n.kind === "tool" && (n as ToolCallNode).toolCallId === "tc-199",
      ) as ToolCallNode;
      expect(lastTool.status).toBe("completed");
      expect(lastTool.result).toEqual({ iteration: 199 });

      // All thinking nodes should be completed (auto-completed by tool start)
      const thinkingNodes = state.nodes.filter((n) => n.kind === "thinking");
      expect(thinkingNodes).toHaveLength(200);
      thinkingNodes.forEach((n) => expect(n.status).toBe("completed"));
    });
  });

  // ---- toolCallIdMap integrity after RESET --------------------------------

  describe("toolCallIdMap integrity", () => {
    it("toolCallIdMap indices are correct after RESET and rebuild", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      // Build state with 5 tools
      for (let i = 0; i < 5; i++) {
        state = timelineReducer(state, {
          type: "ADD_TOOL_START",
          id: `t${i}`,
          toolCallId: `tc-old-${i}`,
          toolName: `tool_${i}`,
          serverName: "s",
          timestamp: T + i,
        });
      }
      expect(Object.keys(state.toolCallIdMap)).toHaveLength(5);

      // RESET
      state = timelineReducer(state, { type: "RESET" });
      expect(state.toolCallIdMap).toEqual({});

      // Rebuild with new tools — indices should start from 0 again
      for (let i = 0; i < 3; i++) {
        state = timelineReducer(state, {
          type: "ADD_TOOL_START",
          id: `t-new-${i}`,
          toolCallId: `tc-new-${i}`,
          toolName: `new_tool_${i}`,
          serverName: "s",
          timestamp: T + 100 + i,
        });
      }

      expect(state.nodes).toHaveLength(3);
      expect(state.toolCallIdMap["tc-new-0"]).toBe(0);
      expect(state.toolCallIdMap["tc-new-1"]).toBe(1);
      expect(state.toolCallIdMap["tc-new-2"]).toBe(2);

      // Old IDs should NOT be in the map
      expect(state.toolCallIdMap["tc-old-0"]).toBeUndefined();

      // Complete a tool and verify correct node is updated
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-new-1",
        result: { rebuilt: true },
        timestamp: T + 200,
      });

      const node = nodeAt(state.nodes, 1, "tool");
      expect(node.status).toBe("completed");
      expect(node.result).toEqual({ rebuilt: true });
    });

    it("multiple RESETs interspersed with builds produce clean state each time", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      for (let cycle = 0; cycle < 5; cycle++) {
        // Build up state
        state = timelineReducer(state, {
          type: "ADD_THINKING",
          id: `n-${cycle}`,
          content: `Cycle ${cycle}`,
          timestamp: T + cycle * 100,
        });
        state = timelineReducer(state, {
          type: "ADD_TOOL_START",
          id: `t-${cycle}`,
          toolCallId: `tc-cycle-${cycle}`,
          toolName: "test",
          serverName: "s",
          timestamp: T + cycle * 100 + 1,
        });

        expect(state.nodes.length).toBeGreaterThan(0);

        // RESET
        state = timelineReducer(state, { type: "RESET" });
        expect(state.nodes).toHaveLength(0);
        expect(state.toolCallIdMap).toEqual({});
      }

      // After all resets, state is clean
      expect(state).toEqual(INITIAL_TIMELINE_STATE);
    });

    it("toolCallIdMap handles same toolCallId reused after completing", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-reuse",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-reuse",
        result: { first: true },
        timestamp: T + 100,
      });

      // Start another tool with the SAME toolCallId
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t2",
        toolCallId: "tc-reuse",
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T + 200,
      });

      // toolCallIdMap should now point to the NEW node (index 1)
      expect(state.toolCallIdMap["tc-reuse"]).toBe(1);
      expect(state.nodes).toHaveLength(2);

      // Complete the second instance
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-reuse",
        result: { second: true },
        timestamp: T + 300,
      });

      // Second node should be completed with second result
      const secondNode = nodeAt(state.nodes, 1, "tool");
      expect(secondNode.result).toEqual({ second: true });

      // First node should still have first result
      const firstNode = nodeAt(state.nodes, 0, "tool");
      expect(firstNode.result).toEqual({ first: true });
    });
  });

  // ---- Cross-node-type merge isolation ------------------------------------

  describe("cross-node-type merge isolation", () => {
    it("thinking after HITL creates new node, not merged into pre-HITL thinking", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "Before HITL",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-1",
        fieldCount: 5,
        timestamp: T + 100,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n2",
        content: "After HITL",
        timestamp: T + 200,
      });

      expect(state.nodes).toHaveLength(3);
      const first = nodeAt(state.nodes, 0, "thinking");
      expect(first.content).toBe("Before HITL");
      expect(first.status).toBe("completed"); // auto-completed by HITL

      nodeAt(state.nodes, 1, "hitl");

      const second = nodeAt(state.nodes, 2, "thinking");
      expect(second.content).toBe("After HITL");
      expect(second.status).toBe("running"); // new, independent
    });

    it("thinking after producing creates new node, not merged", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "Before produce",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_PRODUCING",
        id: "p1",
        eventType: "zip.ready",
        runId: "run-1",
        downloadUrl: "/download",
        timestamp: T + 100,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n2",
        content: "After produce",
        timestamp: T + 200,
      });

      expect(state.nodes).toHaveLength(3);
      const first = nodeAt(state.nodes, 0, "thinking");
      expect(first.content).toBe("Before produce");
      expect(first.status).toBe("completed");

      const second = nodeAt(state.nodes, 2, "thinking");
      expect(second.content).toBe("After produce");
      expect(second.status).toBe("running");
    });

    it("HITL → HITL → tool: tool does not auto-complete HITL (only thinking)", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-1",
        fieldCount: 10,
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_HITL",
        id: "h2",
        runId: "run-1",
        fieldCount: 20,
        timestamp: T + 100,
      });
      state = timelineReducer(state, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "fill_form",
        serverName: "mcp-pdf",
        timestamp: T + 200,
      });

      expect(state.nodes).toHaveLength(3);
      // Both HITL nodes should still be "waiting" — tool start only completes thinking
      expect(nodeAt(state.nodes, 0, "hitl").status).toBe("waiting");
      expect(nodeAt(state.nodes, 1, "hitl").status).toBe("waiting");
      expect(nodeAt(state.nodes, 2, "tool").status).toBe("running");
    });

    it("status after status does not merge (each is distinct milestone)", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;
      const statuses = [
        "run.ingested", "run.extracting", "run.awaiting_human",
        "run.filling", "run.zipping", "run.done",
      ];

      for (let i = 0; i < statuses.length; i++) {
        state = timelineReducer(state, {
          type: "ADD_STATUS",
          id: `s${i}`,
          eventType: statuses[i]!,
          label: `Status ${i}`,
          timestamp: T + i * 100,
        });
      }

      expect(state.nodes).toHaveLength(6);
      state.nodes.forEach((n, i) => {
        expect(n.kind).toBe("status");
        expect((n as StatusNode).eventType).toBe(statuses[i]);
      });
    });
  });

  // ---- Prototype pollution and injection attempts -------------------------

  describe("prototype pollution and injection in args/results", () => {
    it("tool args with __proto__ key are stored as regular data", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-proto",
        toolName: "test",
        serverName: "s",
        args: {
          __proto__: { isAdmin: true },
          constructor: { prototype: { isAdmin: true } },
          normal: "safe_value",
        } as Record<string, unknown>,
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "tool");
      // Args should be stored as-is without affecting prototype chain
      expect(node.args?.normal).toBe("safe_value");
      // The node itself should not have isAdmin
      expect((node as unknown as Record<string, unknown>).isAdmin).toBeUndefined();
    });

    it("tool result with prototype pollution keys does not affect state", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-inject",
        toolName: "test",
        serverName: "s",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "tc-inject",
        result: {
          __proto__: { polluted: true },
          toString: "overridden",
          valueOf: 42,
          data: "safe",
        },
        timestamp: T + 100,
      });

      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.status).toBe("completed");
      const result = node.result as Record<string, unknown>;
      expect(result.data).toBe("safe");
      // State object should not be polluted
      expect((state as unknown as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("status detail with HTML injection is stored as plain string", () => {
      const xssDetail = '<img src=x onerror=alert(document.cookie)>';
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.failed",
        label: "Run Failed",
        detail: xssDetail,
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "status");
      expect(node.detail).toBe(xssDetail); // Stored as-is, React escapes at render
    });
  });

  // ---- Empty/edge toolCallId values ---------------------------------------

  describe("edge-case toolCallId values", () => {
    it("empty string toolCallId works for pairing", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "",
        toolName: "test",
        serverName: "s",
        timestamp: T,
      });

      expect(state.toolCallIdMap[""]).toBe(0);

      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: "",
        result: { paired: true },
        timestamp: T + 100,
      });

      const node = nodeAt(state.nodes, 0, "tool");
      expect(node.status).toBe("completed");
      expect(node.result).toEqual({ paired: true });
    });

    it("toolCallId with special characters pairs correctly", () => {
      const specialId = "tc-🔧-extract/text?v=2&mode=full#section";
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: specialId,
        toolName: "extract_text",
        serverName: "mcp-pdf",
        timestamp: T,
      });

      expect(state.toolCallIdMap[specialId]).toBe(0);

      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: specialId,
        result: { ok: true },
        timestamp: T + 100,
      });

      expect(nodeAt(state.nodes, 0, "tool").status).toBe("completed");
    });

    it("very long toolCallId (1000 chars) works", () => {
      const longId = "tc-" + "x".repeat(997);
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: longId,
        toolName: "test",
        serverName: "s",
        timestamp: T,
      });

      expect(state.toolCallIdMap[longId]).toBe(0);

      state = timelineReducer(state, {
        type: "UPDATE_TOOL_COMPLETE",
        toolCallId: longId,
        result: {},
        timestamp: T + 100,
      });

      expect(nodeAt(state.nodes, 0, "tool").status).toBe("completed");
    });
  });

  // ---- Full run lifecycle ordering ----------------------------------------

  describe("full run lifecycle ordering", () => {
    it("processes all 7 run statuses in correct order", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;
      const lifecycle: Array<{ event: string; label: string }> = [
        { event: "run.ingested", label: "Run Started" },
        { event: "run.extracting", label: "Extracting Data…" },
        { event: "run.awaiting_human", label: "Awaiting Approval" },
        { event: "run.filling", label: "Filling Forms…" },
        { event: "run.zipping", label: "Creating ZIP…" },
        { event: "run.done", label: "Run Complete" },
      ];

      for (let i = 0; i < lifecycle.length; i++) {
        state = timelineReducer(state, {
          type: "ADD_STATUS",
          id: `s${i}`,
          eventType: lifecycle[i]!.event,
          label: lifecycle[i]!.label,
          timestamp: T + i * 1000,
        });
      }

      expect(state.nodes).toHaveLength(6);

      // All should be completed except none should be "failed"
      state.nodes.forEach((n) => {
        expect(n.kind).toBe("status");
        expect(n.status).toBe("completed");
      });

      // Verify order preserved
      for (let i = 0; i < lifecycle.length; i++) {
        expect((state.nodes[i] as StatusNode).eventType).toBe(lifecycle[i]!.event);
        expect((state.nodes[i] as StatusNode).label).toBe(lifecycle[i]!.label);
      }
    });

    it("processes failed lifecycle: ingested → extracting → failed", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.ingested",
        label: "Run Started",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s2",
        eventType: "run.extracting",
        label: "Extracting…",
        timestamp: T + 100,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n1",
        content: "Attempting extraction",
        timestamp: T + 200,
      });
      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s3",
        eventType: "run.failed",
        label: "Run Failed",
        detail: "Copilot exited with code 1",
        timestamp: T + 300,
      });

      expect(state.nodes).toHaveLength(4);
      // Thinking should be auto-completed by status
      expect(nodeAt(state.nodes, 2, "thinking").status).toBe("completed");
      // Last node is failed
      const failed = nodeAt(state.nodes, 3, "status");
      expect(failed.status).toBe("failed");
      expect(failed.detail).toBe("Copilot exited with code 1");
    });
  });

  // ---- Reducer replay idempotency ----------------------------------------

  describe("reducer replay idempotency", () => {
    it("replaying same action sequence 3 times produces identical state", () => {
      const actions: TimelineAction[] = [
        { type: "ADD_STATUS", id: "s1", eventType: "run.ingested", label: "Start", timestamp: T },
        { type: "ADD_THINKING", id: "n1", content: "Analyzing", timestamp: T + 1 },
        { type: "ADD_THINKING", id: "n2", content: "Planning", timestamp: T + 2 },
        {
          type: "ADD_TOOL_START", id: "t1", toolCallId: "tc-1",
          toolName: "extract", serverName: "mcp-pdf",
          args: { file: "test.pdf" }, timestamp: T + 3,
        },
        { type: "UPDATE_TOOL_COMPLETE", toolCallId: "tc-1", result: { data: "extracted" }, timestamp: T + 4 },
        { type: "ADD_HITL", id: "h1", runId: "run-1", fieldCount: 15, timestamp: T + 5 },
        {
          type: "ADD_TOOL_START", id: "t2", toolCallId: "tc-2",
          toolName: "fill", serverName: "mcp-pdf", timestamp: T + 6,
        },
        { type: "UPDATE_TOOL_COMPLETE", toolCallId: "tc-2", result: { filled: true }, timestamp: T + 7 },
        {
          type: "ADD_PRODUCING", id: "p1", eventType: "zip.ready",
          runId: "run-1", downloadUrl: "/download", timestamp: T + 8,
        },
        { type: "ADD_STATUS", id: "s2", eventType: "run.done", label: "Done", timestamp: T + 9 },
      ];

      const results: TimelineState[] = [];
      for (let run = 0; run < 3; run++) {
        let state: TimelineState = INITIAL_TIMELINE_STATE;
        for (const action of actions) {
          state = timelineReducer(state, action);
        }
        results.push(state);
      }

      // All three runs should produce identical state
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);

      // Structure check: s1, n1+n2 (merged), t1, h1, t2, p1, s2 = 7 nodes
      expect(results[0]!.nodes).toHaveLength(7);
      expect(results[0]!.nodes.map((n) => n.kind)).toEqual([
        "status", "thinking", "tool", "hitl", "tool", "producing", "status",
      ]);
    });
  });

  // ---- Producing after failed run -----------------------------------------

  describe("producing after failed run", () => {
    it("producing node can be added after run.failed (edge case)", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      state = timelineReducer(state, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.failed",
        label: "Run Failed",
        detail: "Error occurred",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_PRODUCING",
        id: "p1",
        eventType: "zip.ready",
        runId: "run-1",
        downloadUrl: "/download",
        timestamp: T + 100,
      });

      expect(state.nodes).toHaveLength(2);
      expect(nodeAt(state.nodes, 0, "status").status).toBe("failed");
      expect(nodeAt(state.nodes, 1, "producing").status).toBe("completed");
    });
  });

  // ---- Thinking content merge with special separators ---------------------

  describe("thinking content merge edge cases", () => {
    it("merging with newline-only content preserves formatting", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "Line 1\nLine 2",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n2",
        content: "Line 3\nLine 4",
        timestamp: T + 1,
      });

      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.content).toBe("Line 1\nLine 2\nLine 3\nLine 4");
    });

    it("merging with only whitespace content", () => {
      let state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "   ",
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_THINKING",
        id: "n2",
        content: "\t\t",
        timestamp: T + 1,
      });

      const node = nodeAt(state.nodes, 0, "thinking");
      expect(node.content).toBe("   \n\t\t");
      expect(node.isGrouped).toBe(true);
    });

    it("merge of 50 single-char thinking events", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX";

      for (let i = 0; i < 50; i++) {
        state = timelineReducer(state, {
          type: "ADD_THINKING",
          id: `n${i}`,
          content: chars[i]!,
          timestamp: T + i,
        });
      }

      expect(state.nodes).toHaveLength(1);
      const node = nodeAt(state.nodes, 0, "thinking");
      const parts = node.content.split("\n");
      expect(parts).toHaveLength(50);
      expect(parts[0]).toBe("a");
      expect(parts[49]).toBe("X");
    });
  });

  // ---- Immutability deep verification ------------------------------------

  describe("deep immutability verification", () => {
    it("ADD_STATUS does not mutate the previous nodes array reference", () => {
      const state1 = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "first",
        timestamp: T,
      });
      const prevNodes = state1.nodes;
      const prevNode = state1.nodes[0]!;

      const state2 = timelineReducer(state1, {
        type: "ADD_STATUS",
        id: "s1",
        eventType: "run.done",
        label: "Done",
        timestamp: T + 100,
      });

      // Previous nodes array length should be unchanged
      expect(prevNodes).toHaveLength(1);
      // Previous node object should be unchanged (still running)
      expect(prevNode.status).toBe("running");
      // New state has 2 nodes
      expect(state2.nodes).toHaveLength(2);
      // But the thinking node in new state is completed
      expect(state2.nodes[0]!.status).toBe("completed");
    });

    it("ADD_HITL does not mutate the previous thinking node", () => {
      const state1 = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "thinking",
        timestamp: T,
      });
      const thinkingRef = state1.nodes[0]!;

      const state2 = timelineReducer(state1, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-1",
        timestamp: T + 100,
      });

      // Original reference should still be "running"
      expect(thinkingRef.status).toBe("running");
      // New state's copy should be "completed"
      expect(state2.nodes[0]!.status).toBe("completed");
    });

    it("toolCallIdMap is not shared between states", () => {
      const state1 = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        toolCallId: "tc-1",
        toolName: "test",
        serverName: "s",
        timestamp: T,
      });

      const state2 = timelineReducer(state1, {
        type: "ADD_TOOL_START",
        id: "t2",
        toolCallId: "tc-2",
        toolName: "test2",
        serverName: "s",
        timestamp: T + 1,
      });

      // state1's map should only have tc-1
      expect(Object.keys(state1.toolCallIdMap)).toHaveLength(1);
      expect(state1.toolCallIdMap["tc-1"]).toBe(0);
      expect(state1.toolCallIdMap["tc-2"]).toBeUndefined();

      // state2's map should have both
      expect(Object.keys(state2.toolCallIdMap)).toHaveLength(2);
    });
  });

  // ---- Mixed HITL + Producing interaction --------------------------------

  describe("mixed HITL and producing interaction", () => {
    it("HITL followed by producing followed by another HITL", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      state = timelineReducer(state, {
        type: "ADD_HITL",
        id: "h1",
        runId: "run-1",
        fieldCount: 5,
        timestamp: T,
      });
      state = timelineReducer(state, {
        type: "ADD_PRODUCING",
        id: "p1",
        eventType: "zip.ready",
        runId: "run-1",
        downloadUrl: "/download/1",
        timestamp: T + 100,
      });
      state = timelineReducer(state, {
        type: "ADD_HITL",
        id: "h2",
        runId: "run-1",
        fieldCount: 10,
        timestamp: T + 200,
      });

      expect(state.nodes).toHaveLength(3);
      expect(state.nodes[0]!.kind).toBe("hitl");
      expect(state.nodes[1]!.kind).toBe("producing");
      expect(state.nodes[2]!.kind).toBe("hitl");
    });

    it("producing with empty downloadUrl", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_PRODUCING",
        id: "p1",
        eventType: "zip.ready",
        runId: "run-1",
        downloadUrl: "",
        timestamp: T,
      });

      const node = nodeAt(state.nodes, 0, "producing");
      expect(node.downloadUrl).toBe("");
      expect(node.status).toBe("completed");
    });
  });

  // ---- Action with no matching handler ------------------------------------

  describe("malformed action resilience", () => {
    it("unknown action type with extra fields returns state unchanged", () => {
      const state = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_THINKING",
        id: "n1",
        content: "existing",
        timestamp: T,
      });

      const result = timelineReducer(state, {
        type: "DESTROY_ALL",
        nuke: true,
        secret: "admin",
      } as unknown as TimelineAction);

      expect(result).toBe(state);
      expect(result.nodes).toHaveLength(1);
    });

    it("action with missing required fields for tool start still processes", () => {
      // @ts-expect-error — testing runtime safety with partial action
      const result = timelineReducer(INITIAL_TIMELINE_STATE, {
        type: "ADD_TOOL_START",
        id: "t1",
        // Missing toolCallId, toolName, serverName
        timestamp: T,
      });

      // Should still create a node (undefined fields)
      expect(result.nodes).toHaveLength(1);
      const node = result.nodes[0]!;
      expect(node.kind).toBe("tool");
    });
  });

  // ---- Concurrent tool completion stress ----------------------------------

  describe("concurrent tool completion stress", () => {
    it("20 concurrent tools completed in random order", () => {
      let state: TimelineState = INITIAL_TIMELINE_STATE;

      // Start 20 tools
      for (let i = 0; i < 20; i++) {
        state = timelineReducer(state, {
          type: "ADD_TOOL_START",
          id: `t${i}`,
          toolCallId: `tc-${i}`,
          toolName: `tool_${i}`,
          serverName: "mcp-pdf",
          args: { index: i },
          timestamp: T + i,
        });
      }

      expect(state.nodes).toHaveLength(20);

      // Complete in shuffled order: 15, 3, 18, 0, 7, 12, 19, 1, 9, 5, 
      // 16, 8, 2, 14, 6, 11, 17, 4, 10, 13
      const completionOrder = [15, 3, 18, 0, 7, 12, 19, 1, 9, 5, 16, 8, 2, 14, 6, 11, 17, 4, 10, 13];

      for (const idx of completionOrder) {
        state = timelineReducer(state, {
          type: "UPDATE_TOOL_COMPLETE",
          toolCallId: `tc-${idx}`,
          result: { completedIdx: idx },
          timestamp: T + 100 + idx,
        });
      }

      // All 20 should be completed
      expect(state.nodes).toHaveLength(20);
      state.nodes.forEach((n, i) => {
        expect(n.kind).toBe("tool");
        expect(n.status).toBe("completed");
        const tool = n as ToolCallNode;
        expect(tool.result).toEqual({ completedIdx: i });
      });
    });
  });
});

// ===========================================================================
// P8v2 — completeRunningThinking edge cases
// Additional edge cases for the helper function.
// ===========================================================================

describe("P8v2 — completeRunningThinking additional edge cases", () => {
  it("does not affect non-tail running thinking nodes (only tail)", () => {
    const nodes: TimelineNode[] = [
      {
        id: "n1",
        kind: "thinking",
        status: "running",
        startedAt: T,
        content: "first running",
        isGrouped: false,
      },
      {
        id: "n2",
        kind: "thinking",
        status: "running",
        startedAt: T + 50,
        content: "second running",
        isGrouped: false,
      },
    ];

    const result = completeRunningThinking(nodes, T + 100);

    // Only the LAST (tail) node should be completed
    expect(result).not.toBe(nodes);
    expect(result).toHaveLength(2);
    expect((result[0] as ThinkingNode).status).toBe("running"); // NOT completed
    expect((result[1] as ThinkingNode).status).toBe("completed");
    expect((result[1] as ThinkingNode).completedAt).toBe(T + 100);
  });

  it("handles nodes array with single thinking node at failed status", () => {
    const nodes: TimelineNode[] = [
      {
        id: "n1",
        kind: "thinking",
        status: "failed" as NodeStatus,
        startedAt: T,
        content: "failed thought",
        isGrouped: false,
      },
    ];

    const result = completeRunningThinking(nodes, T + 100);
    // "failed" is not "running", so no change
    expect(result).toBe(nodes);
  });
});
