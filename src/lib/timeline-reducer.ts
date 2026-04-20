/**
 * Timeline Reducer — Pure state machine for the ThoughtPanel timeline.
 *
 * Extracted from thought-panel.tsx for testability. Manages the TimelineNode[]
 * array with merge/update semantics:
 *   1. Consecutive thinking events merge into a single ThinkingNode
 *   2. tool.execution_start creates a ToolCallNode; tool.execution_complete
 *      updates the SAME node via toolCallIdMap lookup (paired events)
 *   3. Non-thinking events auto-complete any running ThinkingNode
 *
 * This module contains NO React imports — purely functional state transitions.
 */

// ---------------------------------------------------------------------------
// Timeline Node Types — Three-layer visual taxonomy
// ---------------------------------------------------------------------------

/** Status of any timeline node — drives icon, color, and collapse behavior. */
export type NodeStatus = "pending" | "running" | "completed" | "failed" | "waiting";

/** Shared fields for every timeline node. */
export interface BaseNode {
  id: string;
  status: NodeStatus;
  startedAt: number;
  completedAt?: number;
}

/** Reasoning/thinking events — grouped when consecutive. */
export interface ThinkingNode extends BaseNode {
  kind: "thinking";
  content: string;
  isGrouped: boolean;
}

/** Tool execution — paired start+complete share one node. */
export interface ToolCallNode extends BaseNode {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  serverName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

/** Run lifecycle milestone (thin one-liner). */
export interface StatusNode extends BaseNode {
  kind: "status";
  eventType: string;
  label: string;
  detail?: string;
}

/** Human-in-the-loop approval gate. */
export interface HitlNode extends BaseNode {
  kind: "hitl";
  fieldCount?: number;
  runId: string;
}

/** Final output (ZIP download, completion). */
export interface ProducingNode extends BaseNode {
  kind: "producing";
  eventType: string;
  runId: string;
  downloadUrl: string;
}

/** Discriminated union of all timeline node types. */
export type TimelineNode =
  | ThinkingNode
  | ToolCallNode
  | StatusNode
  | HitlNode
  | ProducingNode;

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

/** Combined state for the timeline reducer. */
export interface TimelineState {
  /** Ordered list of timeline nodes to render. */
  nodes: TimelineNode[];
  /** Maps toolCallId → index in nodes[] for O(1) paired event lookup. */
  toolCallIdMap: Record<string, number>;
}

/** Discriminated union of all timeline reducer actions. */
export type TimelineAction =
  | { type: "ADD_THINKING"; id: string; content: string; timestamp: number }
  | {
      type: "ADD_TOOL_START";
      id: string;
      toolCallId: string;
      toolName: string;
      serverName: string;
      args?: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: "UPDATE_TOOL_COMPLETE";
      toolCallId: string;
      result?: unknown;
      error?: string;
      timestamp: number;
    }
  | {
      type: "ADD_STATUS";
      id: string;
      eventType: string;
      label: string;
      detail?: string;
      timestamp: number;
    }
  | {
      type: "ADD_HITL";
      id: string;
      runId: string;
      fieldCount?: number;
      timestamp: number;
    }
  | {
      type: "ADD_PRODUCING";
      id: string;
      eventType: string;
      runId: string;
      downloadUrl: string;
      timestamp: number;
    }
  | { type: "RESET" };

export const INITIAL_TIMELINE_STATE: TimelineState = {
  nodes: [],
  toolCallIdMap: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Auto-complete any running ThinkingNode at the tail of the nodes array.
 * Returns a new array if the tail was modified, otherwise the original array.
 */
export function completeRunningThinking(
  nodes: TimelineNode[],
  timestamp: number,
): TimelineNode[] {
  const lastIdx = nodes.length - 1;
  if (lastIdx < 0) return nodes;
  const last = nodes[lastIdx];
  if (last?.kind === "thinking" && last.status === "running") {
    const updated = [...nodes];
    updated[lastIdx] = { ...last, status: "completed" as const, completedAt: timestamp };
    return updated;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Pure reducer for timeline state transitions. */
export function timelineReducer(
  state: TimelineState,
  action: TimelineAction,
): TimelineState {
  switch (action.type) {
    case "ADD_THINKING": {
      const { id, content, timestamp } = action;
      const lastIdx = state.nodes.length - 1;
      const last = lastIdx >= 0 ? state.nodes[lastIdx] : null;

      // Merge into existing running ThinkingNode if consecutive
      if (last && last.kind === "thinking" && last.status === "running") {
        const updated = [...state.nodes];
        updated[lastIdx] = {
          ...last,
          content: last.content + "\n" + content,
          isGrouped: true,
        };
        return { ...state, nodes: updated };
      }

      // Create new ThinkingNode
      const node: ThinkingNode = {
        id,
        kind: "thinking",
        status: "running",
        startedAt: timestamp,
        content,
        isGrouped: false,
      };
      return { ...state, nodes: [...state.nodes, node] };
    }

    case "ADD_TOOL_START": {
      const { id, toolCallId, toolName, serverName, args, timestamp } = action;
      // Auto-complete running thinking before adding tool node
      const nodes = completeRunningThinking(state.nodes, timestamp);
      const node: ToolCallNode = {
        id,
        kind: "tool",
        status: "running",
        startedAt: timestamp,
        toolCallId,
        toolName,
        serverName,
        args,
      };
      const newNodes = [...nodes, node];
      return {
        nodes: newNodes,
        toolCallIdMap: {
          ...state.toolCallIdMap,
          [toolCallId]: newNodes.length - 1,
        },
      };
    }

    case "UPDATE_TOOL_COMPLETE": {
      const { toolCallId, result, error, timestamp } = action;
      const idx = state.toolCallIdMap[toolCallId];
      if (idx === undefined) return state;
      const existing = state.nodes[idx];
      if (!existing || existing.kind !== "tool") return state;

      const updated = [...state.nodes];
      updated[idx] = {
        ...existing,
        status: error ? ("failed" as const) : ("completed" as const),
        completedAt: timestamp,
        result,
        error,
      };
      return { ...state, nodes: updated };
    }

    case "ADD_STATUS": {
      const { id, eventType, label, detail, timestamp } = action;
      let nodes = completeRunningThinking(state.nodes, timestamp);

      // When run progresses past awaiting_human, mark HitlNodes as completed
      if (eventType === "run.filling" || eventType === "run.zipping" || eventType === "run.done") {
        const hasWaiting = nodes.some((n) => n.kind === "hitl" && n.status === "waiting");
        if (hasWaiting) {
          nodes = nodes.map((n) =>
            n.kind === "hitl" && n.status === "waiting"
              ? { ...n, status: "completed" as const, completedAt: timestamp }
              : n,
          );
        }
      }

      const node: StatusNode = {
        id,
        kind: "status",
        status: eventType === "run.failed" ? "failed" : "completed",
        startedAt: timestamp,
        completedAt: timestamp,
        eventType,
        label,
        detail,
      };
      return { ...state, nodes: [...nodes, node] };
    }

    case "ADD_HITL": {
      const { id, runId, fieldCount, timestamp } = action;
      const nodes = completeRunningThinking(state.nodes, timestamp);
      const node: HitlNode = {
        id,
        kind: "hitl",
        status: "waiting",
        startedAt: timestamp,
        runId,
        fieldCount,
      };
      return { ...state, nodes: [...nodes, node] };
    }

    case "ADD_PRODUCING": {
      const { id, eventType, runId, downloadUrl, timestamp } = action;
      const nodes = completeRunningThinking(state.nodes, timestamp);
      const node: ProducingNode = {
        id,
        kind: "producing",
        status: "completed",
        startedAt: timestamp,
        completedAt: timestamp,
        eventType,
        runId,
        downloadUrl,
      };
      return { ...state, nodes: [...nodes, node] };
    }

    case "RESET":
      return INITIAL_TIMELINE_STATE;

    default:
      return state;
  }
}
