"use client";

/**
 * ThoughtPanel — Read-only right-hand panel streaming Copilot events via SSE.
 *
 * Subscribes to `/api/runs/:id/events` via EventSource.
 * Renders a VS Code Chat-style vertical timeline with three visual layers:
 *   - Thinking (Brain) — reasoning.trace, assistant.message/reasoning
 *   - Doing   (Zap)   — tool.execution_start/complete, run.extracting/filling/zipping
 *   - Producing (Download) — zip.ready, human.prompt, run.done/failed
 *
 * Uses a useReducer-based state model that supports:
 *   - Paired tool events (start → complete merge into one node)
 *   - Consecutive thinking grouping (within 500ms)
 *   - Status-driven auto-collapse
 *   - Smart auto-scroll with user override
 *
 * Read-only — no user input.
 */

import { useEffect, useReducer, useRef, useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Brain,
  Zap,
  Loader2,
  Check,
  XCircle,
  AlertTriangle,
  Download,
  ChevronDown,
  ChevronRight,
  ArrowDown,
  BotMessageSquare,
  Activity,
  X,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  type NodeStatus,
  type ThinkingNode,
  type ToolCallNode,
  type StatusNode,
  type HitlNode,
  type ProducingNode,
  type TimelineNode,
  INITIAL_TIMELINE_STATE,
  timelineReducer,
} from "@/lib/timeline-reducer";
import { MarkdownContent } from "@/components/markdown-content";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a parsed SSE data payload from the EventBus. */
interface SSEEvent {
  type: string;
  seq: number;
  ts: string;
  runId?: string;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ThoughtPanelProps {
  /** Active run ID to subscribe to, or null when idle. */
  runId: string | null;
}

// ---------------------------------------------------------------------------
// Quota types (mirrors QuotaApiResponse from lib/quota/types.ts)
// ---------------------------------------------------------------------------

interface QuotaData {
  remaining: number | null;
  limit: number | null;
  resetAt: string;
  scope: string;
  degraded?: boolean;
}

// ---------------------------------------------------------------------------
// Component — Outer shell
// ---------------------------------------------------------------------------

export function ThoughtPanel({ runId }: ThoughtPanelProps) {
  const [quotaOpen, setQuotaOpen] = useState(false);

  return (
    <aside className="flex h-full w-[36rem] flex-col overflow-hidden border-l border-neutral-700 bg-neutral-950">
      <Dialog.Root open={quotaOpen} onOpenChange={setQuotaOpen}>
        <Dialog.Trigger asChild>
          <header className="flex cursor-pointer items-center gap-2 border-b border-neutral-700 px-4 py-3 transition-colors hover:bg-neutral-900">
            <BotMessageSquare className="h-4 w-4 text-neutral-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Copilot Thoughts
            </h3>
            <Activity className="ml-auto h-3.5 w-3.5 text-neutral-500" />
          </header>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content className="fixed right-4 top-14 z-50 w-[36rem] max-h-[calc(100vh-25px)] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <Dialog.Title className="text-sm font-semibold text-neutral-100">
                Premium Request Usage
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">
              Copilot premium request usage metrics and session details.
            </Dialog.Description>
            <QuotaPopupContent />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {runId ? (
        <ThoughtStream key={runId} runId={runId} />
      ) : (
        <div className="flex-1 px-3 py-2 text-sm">
          <p className="mt-8 text-center text-xs text-neutral-600">
            Upload a title PDF to start…
          </p>
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// QuotaPopupContent — fetches and displays premium request usage
// ---------------------------------------------------------------------------

function QuotaPopupContent() {
  const [data, setData] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadQuota = useCallback(() => {
    let cancelled = false;
    fetch("/api/quota")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as QuotaData;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Unknown error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return loadQuota();
  }, [loadQuota]);

  if (loading) {
    return (
      <p className="text-xs text-neutral-500">Loading usage data…</p>
    );
  }
  if (error) {
    return (
      <p className="text-xs text-red-400">Failed to load: {error}</p>
    );
  }
  if (!data) return null;

  const resetDate = new Date(data.resetAt);
  const now = new Date();
  const daysUntilReset = Math.max(
    0,
    Math.ceil((resetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
  );

  const usagePercent =
    data.limit !== null && data.remaining !== null && data.limit > 0
      ? Math.round(((data.limit - data.remaining) / data.limit) * 100)
      : null;

  return (
    <div className="space-y-4">
      {/* Usage bar */}
      {data.degraded ? (
        <div className="rounded-md border border-yellow-700/40 bg-yellow-950/30 p-3">
          <p className="text-xs font-medium text-yellow-400">
            Managed Account
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            Quota metrics are not available via API for organization-managed
            accounts.
          </p>
          <a
            href="https://github.com/settings/billing"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs text-blue-400 underline hover:text-blue-300"
          >
            View billing on GitHub →
          </a>
        </div>
      ) : (
        <>
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-xs text-neutral-400">Premium Requests</span>
              <span className="text-xs font-mono text-neutral-200">
                {data.remaining !== null && data.limit !== null
                  ? Math.round((data.limit - data.remaining) * 10) / 10
                  : "—"}{" "}
                <span className="text-neutral-500">
                  / {data.limit !== null ? data.limit : "—"}
                </span>
              </span>
            </div>
            {/* Progress bar */}
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className={`h-full rounded-full transition-all ${
                  usagePercent !== null && usagePercent > 80
                    ? "bg-red-500"
                    : usagePercent !== null && usagePercent > 50
                      ? "bg-yellow-500"
                      : "bg-emerald-500"
                }`}
                style={{ width: `${usagePercent ?? 0}%` }}
              />
            </div>
            {usagePercent !== null && (
              <p className="mt-1 text-right text-[10px] text-neutral-500">
                {usagePercent}% used
              </p>
            )}
          </div>
        </>
      )}

      {/* Details grid */}
      <div className="grid grid-cols-2 gap-3">
        <QuotaMetric
          label="Quote reset date"
          value={resetDate.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        />
        <QuotaMetric label="Quote resets in" value={`${daysUntilReset}d`} />
        <QuotaMetric label="Scope" value={data.scope} />
        <QuotaMetric label="Model" value="claude-haiku-4.5" />
      </div>

      {/* Session info */}
      <div className="border-t border-neutral-800 pt-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Current Session
        </p>
        <div className="grid grid-cols-2 gap-3">
          <QuotaMetric
            label="Agent"
            value="Copilot CLI"
          />
          <div>
            <p className="text-[10px] text-neutral-500">MCP Servers</p>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {["mcp-pdf", "pymupdf4llm"].map((s) => (
                <span
                  key={s}
                  className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-mono text-neutral-400"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Agent Tools by MCP server */}
      <div className="border-t border-neutral-800 pt-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Agent Tools
        </p>
        <div className="space-y-2 overflow-y-auto">
          {MCP_TOOL_REGISTRY.map((server) => (
            <McpToolGroup key={server.name} server={server} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP Tool Registry — static catalogue of tools exposed by each MCP server.
// Source: references/research/MCP_PDF_SERVERS_HIGH_QUALITY_REFERENCE.md
// ---------------------------------------------------------------------------

interface McpToolServer {
  /** Display name of the MCP server. */
  name: string;
  /** Tool names exposed by this server. */
  tools: string[];
}

/** Static registry of MCP servers and their tools used in the pipeline. */
const MCP_TOOL_REGISTRY: McpToolServer[] = [
  {
    name: "mcp-pdf",
    tools: [
      "extract_text",
      "extract_tables",
      "extract_form_data",
      "fill_form_pdf",
      "create_form_pdf",
      "add_form_fields",
      "fill_permit_form",
      "get_field_schema",
      "validate_permit_form_data",
      "preview_field_positions",
      "merge_pdfs",
      "split_pdf_by_pages",
      "split_pdf_by_bookmarks",
      "reorder_pdf_pages",
      "add_sticky_notes",
      "add_highlights",
      "add_stamps",
      "extract_all_annotations",
      "insert_attachment_pages",
    ],
  },
  {
    name: "pymupdf4llm",
    tools: ["convert_pdf"],
  },
];

/** Collapsible group listing tools for a single MCP server. */
function McpToolGroup({ server }: { server: McpToolServer }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-neutral-300 hover:bg-neutral-900"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-neutral-500" />
        )}
        <span>{server.name}</span>
        <span className="ml-auto text-[10px] text-neutral-600">
          {server.tools.length} tools
        </span>
      </button>
      {open && (
        <div className="flex flex-wrap gap-1 border-t border-neutral-800 px-2 py-1.5">
          {server.tools.map((tool) => (
            <span
              key={tool}
              className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-mono text-neutral-400"
            >
              {tool}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Small metric cell for the quota popup. */
function QuotaMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-neutral-500">{label}</p>
      <p className="text-xs font-medium text-neutral-200">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool → Server lookup — derived from MCP_TOOL_REGISTRY for O(1) resolution.
// Used by ToolCallNode to display which MCP server a tool belongs to.
// ---------------------------------------------------------------------------

const TOOL_TO_SERVER: Record<string, string> = {};
for (const server of MCP_TOOL_REGISTRY) {
  for (const tool of server.tools) {
    TOOL_TO_SERVER[tool] = server.name;
  }
}

// ---------------------------------------------------------------------------
// Status label mapping — human-readable labels + dot colors for run/milestone
// events. Maps SSE event type → display properties.
// ---------------------------------------------------------------------------

interface StatusLabelEntry {
  /** Human-readable label shown in the timeline. */
  label: string;
  /** Tailwind text-color class for the status dot. */
  dotColor: string;
}

const STATUS_LABELS: Record<string, StatusLabelEntry> = {
  "run.ingested":       { label: "Run Started",         dotColor: "text-neutral-400" },
  "run.extracting":     { label: "Extracting Data…",    dotColor: "text-blue-400" },
  "run.awaiting_human": { label: "Awaiting Approval",   dotColor: "text-amber-400" },
  "run.filling":        { label: "Filling Forms…",      dotColor: "text-blue-400" },
  "run.zipping":        { label: "Packaging ZIP…",      dotColor: "text-blue-400" },
  "run.done":           { label: "Run Complete",        dotColor: "text-emerald-400" },
  "run.failed":         { label: "Run Failed",          dotColor: "text-red-400" },
  "extract.done":       { label: "Extraction Complete", dotColor: "text-emerald-400" },
  "fill.done":          { label: "Forms Filled",        dotColor: "text-emerald-400" },
};

// ---------------------------------------------------------------------------
// useElapsedTime — live elapsed time display for running nodes.
// While running: updates every 100ms. On completion: shows static duration.
// ---------------------------------------------------------------------------

function useElapsedTime(startedAt: number, completedAt?: number): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (completedAt) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [completedAt]);

  const elapsed = ((completedAt ?? now) - startedAt) / 1000;
  if (elapsed < 60) return `${elapsed.toFixed(1)}s`;
  return `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`;
}

// ---------------------------------------------------------------------------
// Inner stream — keyed by runId so state resets on run change.
// Uses useReducer for merge/update semantics (paired tools, grouped thinking).
// ---------------------------------------------------------------------------

function ThoughtStream({ runId }: { runId: string }) {
  const [state, dispatch] = useReducer(timelineReducer, INITIAL_TIMELINE_STATE);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Track seen event seq numbers to deduplicate on SSE reconnect. */
  const seenSeqs = useRef<Set<number>>(new Set());
  /** Whether user has manually scrolled away from bottom. */
  const isUserScrolled = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  /** Resolve MCP server name for a tool, with fallback. */
  const resolveServer = useCallback((toolName: string): string => {
    return TOOL_TO_SERVER[toolName] ?? "unknown";
  }, []);

  /** Track user scroll position for smart auto-scroll. */
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    isUserScrolled.current = !atBottom;
    setShowScrollBtn(!atBottom);
  }, []);

  /** Scroll to bottom and re-enable auto-scroll. */
  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
    isUserScrolled.current = false;
    setShowScrollBtn(false);
  }, []);

  // SSE subscription — dispatches reducer actions instead of appending rows
  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/events`);

    /** Handler factory for SSE `event:` types (agent, run, bus). */
    const handleChannel = (_channel: string) => (ev: MessageEvent) => {
      try {
        const data: SSEEvent = JSON.parse(ev.data as string);
        // Deduplicate events on SSE reconnect (Last-Event-ID replay).
        if (seenSeqs.current.has(data.seq)) return;
        seenSeqs.current.add(data.seq);

        const now = Date.now();
        const id = `node-${data.seq}`;

        switch (data.type) {
          // ----- Thinking layer -----
          case "assistant.message": {
            const p = data.payload as
              | { content?: string; text?: string }
              | undefined;
            const text = p?.content ?? p?.text ?? String(data.payload ?? "");
            if (text) {
              dispatch({ type: "ADD_THINKING", id, content: text, timestamp: now });
            }
            break;
          }
          case "assistant.reasoning":
          case "reasoning.trace": {
            const p = data.payload as
              | { content?: string; text?: string }
              | undefined;
            const text = p?.content ?? p?.text ?? String(data.payload ?? "");
            if (text) {
              dispatch({ type: "ADD_THINKING", id, content: text, timestamp: now });
            }
            break;
          }

          // ----- Doing layer -----
          case "tool.execution_start": {
            const p = data.payload as
              | {
                  toolCallId?: string;
                  toolName?: string;
                  arguments?: Record<string, unknown>;
                }
              | undefined;
            const toolCallId = p?.toolCallId ?? id;
            const toolName = p?.toolName ?? "unknown";
            dispatch({
              type: "ADD_TOOL_START",
              id,
              toolCallId,
              toolName,
              serverName: resolveServer(toolName),
              args: p?.arguments,
              timestamp: now,
            });
            break;
          }
          case "tool.execution_complete": {
            const p = data.payload as
              | {
                  toolCallId?: string;
                  success?: boolean;
                  result?: Record<string, unknown>;
                  error?: Record<string, unknown>;
                }
              | undefined;
            if (p?.toolCallId) {
              dispatch({
                type: "UPDATE_TOOL_COMPLETE",
                toolCallId: p.toolCallId,
                result: p.success ? p.result : undefined,
                error: p.error
                  ? JSON.stringify(p.error)
                  : p.success === false
                    ? "Tool execution failed"
                    : undefined,
                timestamp: now,
              });
            }
            break;
          }

          // ----- HITL layer -----
          case "human.prompt": {
            const p = data.payload as
              | { fields?: Record<string, unknown> }
              | undefined;
            const fieldCount = p?.fields
              ? Object.keys(p.fields).length
              : undefined;
            dispatch({
              type: "ADD_HITL",
              id,
              runId,
              fieldCount,
              timestamp: now,
            });
            break;
          }

          // ----- Producing layer -----
          case "zip.ready": {
            dispatch({
              type: "ADD_PRODUCING",
              id,
              eventType: data.type,
              runId,
              downloadUrl: `/api/runs/${runId}/download`,
              timestamp: now,
            });
            break;
          }

          // ----- Status / milestone layer -----
          default: {
            const entry = STATUS_LABELS[data.type];
            if (entry) {
              const detail =
                data.type === "run.failed"
                  ? (data.payload as { error?: string } | undefined)?.error
                  : undefined;
              dispatch({
                type: "ADD_STATUS",
                id,
                eventType: data.type,
                label: entry.label,
                detail,
                timestamp: now,
              });
            }
            // Ignore unrecognized events (deltas, user.message, agent.raw, etc.)
            break;
          }
        }
      } catch {
        // Malformed SSE data — skip silently.
      }
    };

    es.addEventListener("agent", handleChannel("agent"));
    es.addEventListener("run", handleChannel("run"));
    es.addEventListener("bus", handleChannel("bus"));

    es.onerror = () => {
      // EventSource auto-reconnects; no action needed.
    };

    return () => {
      es.close();
    };
  }, [runId, resolveServer]);

  // Smart auto-scroll — only scrolls when user hasn't manually scrolled up
  useEffect(() => {
    if (!isUserScrolled.current) {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [state.nodes]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="relative flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 text-sm"
      aria-live="polite"
    >
      {state.nodes.length === 0 && (
        <p className="mt-8 text-center text-xs text-neutral-600">
          Listening for Copilot events…
        </p>
      )}
      {state.nodes.length > 0 && (
        <TimelineContainer nodes={state.nodes} />
      )}
      {showScrollBtn && <ScrollToBottomButton onClick={scrollToBottom} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineContainer — vertical connector line + node dispatch.
// Each node sits alongside a left-edge connector with status indicators.
// ---------------------------------------------------------------------------

/** Status → icon component lookup for connector-line dots. */
const STATUS_ICON: Record<NodeStatus, typeof Loader2> = {
  pending: Loader2,
  running: Loader2,
  completed: Check,
  failed: XCircle,
  waiting: AlertTriangle,
};

/** Status → Tailwind color class for connector-line dot icons. */
const STATUS_ICON_COLOR: Record<NodeStatus, string> = {
  pending: "text-neutral-400",
  running: "text-blue-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  waiting: "text-amber-400",
};

function TimelineContainer({ nodes }: { nodes: TimelineNode[] }) {
  return (
    <div
      className="relative space-y-1"
      role="list"
      aria-label="Agent timeline"
    >
      {nodes.map((node) => (
        <TimelineNodeRenderer key={node.id} node={node} />
      ))}
    </div>
  );
}

/**
 * TimelineNodeRenderer — renders the connector-line status dot and dispatches
 * to the appropriate kind-specific component.
 *
 * Focus management: the wrapper is NOT focusable. Instead, each inner
 * component owns its own tab stop (toggle header for expandable nodes,
 * interactive button/link for action nodes, or the container div for
 * non-expandable StatusNode). This prevents double-tab-stop per node.
 */
function TimelineNodeRenderer({ node }: { node: TimelineNode }) {
  return (
    <div className="relative py-1" role="listitem">
      {/* Node content — dispatched by kind */}
      <div className="min-w-0">
        {node.kind === "thinking" && <ThinkingNodeView node={node} />}
        {node.kind === "tool" && <ToolCallNodeView node={node} />}
        {node.kind === "status" && <StatusNodeView node={node} />}
        {node.kind === "hitl" && <HitlNodeView node={node} />}
        {node.kind === "producing" && <ProducingNodeView node={node} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline Node Components — kind-specific rendering for each node type.
//   - ThinkingNodeView: collapsible accordion for reasoning events
//   - ToolCallNodeView: three-tier progressive disclosure for tool execution
//   - StatusNodeView: single-line milestone marker for run lifecycle
//   - HitlNodeView: amber attention card for human approval gates
//   - ProducingNodeView: blue action card for final ZIP download
// ---------------------------------------------------------------------------

/**
 * ThinkingNodeView — collapsible accordion for reasoning/thinking events.
 *
 * Visual behavior:
 *   - Running: auto-expanded with Loader2 spinner + live elapsed time
 *   - Completed: auto-collapsed with Check icon + final duration
 *   - User can manually toggle expand/collapse at any time
 *   - Grouped events show step count suffix "(N steps)"
 *
 * Accessibility:
 *   - role="button" toggle header with aria-expanded
 *   - Keyboard toggle via Enter/Space
 *   - Labeled with status + elapsed for screen readers
 */
function ThinkingNodeView({ node }: { node: ThinkingNode }) {
  const elapsed = useElapsedTime(node.startedAt, node.completedAt);
  const [expanded, setExpanded] = useState(true);
  /** Markdown rendering toggle — ON by default for styled AI output. */
  const [markdownMode, setMarkdownMode] = useState(true);

  // Count grouped steps from newline-separated content segments
  const stepCount = node.isGrouped
    ? node.content.split("\n").filter(Boolean).length
    : 0;

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  /** Toggle markdown/raw view — stops propagation to avoid expand/collapse. */
  const toggleMarkdown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMarkdownMode((v) => !v);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpanded();
      }
    },
    [toggleExpanded],
  );

  const ariaLabel =
    node.status === "completed"
      ? `Thinking, completed in ${elapsed}`
      : `Thinking, running for ${elapsed}`;

  return (
    <div className={expanded ? "rounded-md bg-neutral-900/50" : ""}>
      {/* Tier 1 — Glanceable header (always visible) */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={ariaLabel}
        onClick={toggleExpanded}
        onKeyDown={handleKeyDown}
        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-800/50"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          {node.status === "running" ? "Thinking…" : "Thinking"}
        </span>
        {node.isGrouped && stepCount > 1 && (
          <span className="text-neutral-600">({stepCount} steps)</span>
        )}
        <span className="ml-auto text-neutral-600">{elapsed}</span>
        {node.status === "running" && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-400" />
        )}
        {node.status === "completed" && (
          <Check className="h-3 w-3 shrink-0 text-emerald-400" />
        )}
        {/* Markdown/raw toggle — eye icon button */}
        <button
          type="button"
          onClick={toggleMarkdown}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={markdownMode ? "Switch to raw text view" : "Switch to markdown view"}
          title={markdownMode ? "View raw text" : "View as markdown"}
          className={`shrink-0 rounded p-0.5 transition-colors hover:bg-neutral-700 ${
            markdownMode ? "text-blue-400" : "text-red-300"
          }`}
        >
          {markdownMode ? (
            <Eye className="h-3 w-3" />
          ) : (
            <EyeOff className="h-3 w-3" />
          )}
        </button>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        )}
      </div>

      {/* Tier 2 — Expanded content: markdown-rendered (default) or raw text */}
      {expanded && (
        <div
          className={`overflow-y-auto px-2 pb-2 ${
            markdownMode ? "max-h-96" : "max-h-40"
          }`}
        >
          {markdownMode ? (
            <MarkdownContent content={node.content} />
          ) : (
            <p className="whitespace-pre-wrap break-words text-xs italic text-neutral-400">
              {node.content}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ToolCallNodeView — three-tier progressive disclosure for tool execution events.
 *
 * Visual behavior:
 *   - Running: auto-expanded with spinner + live elapsed time + args display
 *   - Completed (success): auto-collapsed with Check icon + final duration
 *   - Failed: remains expanded with XCircle icon + error detail in red
 *   - User can manually toggle expand/collapse at any time
 *
 * Three tiers:
 *   1. Glanceable: tool badge + status icon + elapsed time + chevron
 *   2. Context: server name + formatted key-value arguments
 *   3. Raw: full JSON result/error (nested collapsible inside tier 2)
 *
 * Accessibility:
 *   - role="button" toggle header with aria-expanded
 *   - Keyboard toggle via Enter/Space
 *   - Labeled with tool name + status + elapsed for screen readers
 */
function ToolCallNodeView({ node }: { node: ToolCallNode }) {
  const elapsed = useElapsedTime(node.startedAt, node.completedAt);
  const [expanded, setExpanded] = useState(node.status === "running");
  const [rawExpanded, setRawExpanded] = useState(false);
  const prevStatusRef = useRef(node.status);

  // Auto-collapse on success; keep expanded on failure
  useEffect(() => {
    if (prevStatusRef.current === "running" && node.status === "completed") {
      setExpanded(false);
    }
    prevStatusRef.current = node.status;
  }, [node.status]);

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);
  const toggleRaw = useCallback(() => setRawExpanded((v) => !v), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpanded();
      }
    },
    [toggleExpanded],
  );

  const handleRawKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        toggleRaw();
      }
    },
    [toggleRaw],
  );

  // Count raw result fields for the tier 3 toggle label
  const rawFieldCount =
    node.result && typeof node.result === "object" && !Array.isArray(node.result)
      ? Object.keys(node.result as Record<string, unknown>).length
      : 0;

  const ariaLabel =
    node.status === "completed"
      ? `Tool ${node.toolName}, completed in ${elapsed}`
      : node.status === "failed"
        ? `Tool ${node.toolName}, failed after ${elapsed}`
        : `Tool ${node.toolName}, running for ${elapsed}`;

  return (
    <div className={expanded ? "rounded-md bg-neutral-900/50" : ""}>
      {/* Tier 1 — Glanceable header (always visible) */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={ariaLabel}
        onClick={toggleExpanded}
        onKeyDown={handleKeyDown}
        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-neutral-800/50"
      >
        <Zap className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
        <span className="rounded border border-cyan-800/40 bg-cyan-950 px-1.5 py-0.5 font-mono text-cyan-300">
          {node.toolName}
        </span>
        <span className="text-neutral-500">
          {node.status === "running"
            ? "running…"
            : node.status === "failed"
              ? "failed"
              : ""}
        </span>
        <span className="ml-auto text-neutral-600">{elapsed}</span>
        {node.status === "running" && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-400" />
        )}
        {node.status === "completed" && (
          <Check className="h-3 w-3 shrink-0 text-emerald-400" />
        )}
        {node.status === "failed" && (
          <XCircle className="h-3 w-3 shrink-0 text-red-400" />
        )}
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        )}
      </div>

      {/* Tier 2 — Expanded context: server name + formatted arguments */}
      {expanded && (
        <div className="px-2 pb-2">
          {/* Server name label */}
          <div className="mb-1.5 text-[10px] text-neutral-500">
            Server:{" "}
            <span className="text-neutral-400">{node.serverName}</span>
          </div>

          {/* Formatted arguments as key-value pairs (NOT raw JSON) */}
          {node.args && Object.keys(node.args).length > 0 && (
            <div className="mb-1.5">
              <p className="mb-1 text-[10px] text-neutral-500">Arguments:</p>
              <div className="space-y-0.5 font-mono text-xs text-neutral-300">
                {Object.entries(node.args).map(([key, value]) => (
                  <div key={key} className="flex gap-2">
                    <span className="shrink-0 text-neutral-500">{key}</span>
                    <span className="min-w-0 truncate text-neutral-300">
                      {formatArgValue(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error display for failed tools */}
          {node.error && (
            <div className="mt-1.5 rounded bg-red-950/30 px-2 py-1.5 text-xs text-red-400">
              {node.error}
            </div>
          )}

          {/* Tier 3 — Nested collapsible raw JSON result */}
          {node.result != null && (
            <div className="mt-1.5">
              <button
                type="button"
                tabIndex={0}
                aria-expanded={rawExpanded}
                aria-label={`Raw result, ${rawFieldCount} fields`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleRaw();
                }}
                onKeyDown={handleRawKeyDown}
                className="flex items-center gap-1 text-[10px] text-neutral-500 transition-colors hover:text-neutral-400"
              >
                {rawExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                Raw Result
                {rawFieldCount > 0 && ` (${rawFieldCount} fields)`}
              </button>
              {rawExpanded && (
                <pre className="mt-1 max-h-60 overflow-auto rounded bg-neutral-900 p-2 font-mono text-xs text-neutral-500">
                  {JSON.stringify(node.result, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Format a tool argument value for human-readable display in tier 2.
 * Strings >80 chars are truncated with ellipsis.
 * Arrays/objects are rendered as compact JSON, also truncated at 80 chars.
 */
function formatArgValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    return value.length > 80 ? value.slice(0, 77) + "…" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json.length > 80 ? json.slice(0, 77) + "…" : json;
}

/**
 * StatusNodeView — single-line milestone marker for run lifecycle events.
 *
 * Visual behavior:
 *   - One-line display: colored dot + human-readable label + timestamp
 *   - Dot color varies by event type (neutral/blue/amber/green/red)
 *   - Special case: run.failed expands to show error detail
 *   - No expand/collapse for normal milestones
 *
 * Color mapping (per §3.4):
 *   - run.ingested → neutral (gray)
 *   - run.extracting/filling/zipping → blue (active)
 *   - run.awaiting_human → amber (attention)
 *   - extract.done/fill.done/run.done → emerald (success)
 *   - run.failed → red (error, shows detail)
 */
function StatusNodeView({ node }: { node: StatusNode }) {
  const time = new Date(node.startedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const dotColor =
    STATUS_LABELS[node.eventType]?.dotColor ?? "text-neutral-400";
  const isFailed = node.eventType === "run.failed";
  const isDone = node.eventType === "run.done";

  return (
    <div tabIndex={0} aria-label={`${node.label}, ${time}`}>
      {/* Single-line milestone: dot + label + timestamp */}
      <div className="flex items-center gap-2 py-0.5 text-xs">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full bg-current ${dotColor}`}
          aria-hidden="true"
        />
        <span
          className={`font-medium ${
            isFailed
              ? "text-red-400"
              : isDone
                ? "text-emerald-400"
                : "text-neutral-300"
          }`}
        >
          {node.label}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-neutral-600">
          {time}
        </span>
      </div>

      {/* Error detail expansion for run.failed */}
      {isFailed && node.detail && (
        <div className="ml-4 mt-1 rounded bg-red-950/30 px-2 py-1.5 text-xs text-red-400">
          <div className="flex items-start gap-1.5">
            <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="break-words">{node.detail}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * HitlNodeView — amber attention card for human-in-the-loop approval gates.
 *
 * Visual behavior:
 *   - Always expanded (never auto-collapses)
 *   - Pulsing AlertTriangle icon in amber to draw attention
 *   - Field count summary when available
 *   - "Review & Approve" button dispatches `hcd-hitl-open` custom DOM event
 *     which the parent page (new/page.tsx) listens for to re-open the HitlModal
 *
 * Accessibility:
 *   - aria-live="assertive" to immediately announce to screen readers
 *   - Button has descriptive aria-label
 */
function HitlNodeView({ node }: { node: HitlNode }) {
  /** Dispatch custom event to re-open the HITL modal in the parent page. */
  const handleReviewClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent("hcd-hitl-open"));
  }, []);

  const isApproved = node.status === "completed";

  return (
    <div
      className={`rounded-md border p-3 ${
        isApproved
          ? "border-emerald-700/40 bg-emerald-950/30"
          : "border-amber-700/40 bg-amber-950/30"
      }`}
      aria-live="assertive"
    >
      {/* Header — amber pulsing ! when waiting, green check when approved */}
      <div className="flex items-center gap-2">
        {isApproved ? (
          <Check className="h-4 w-4 shrink-0 text-emerald-400" />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 animate-pulse text-amber-400" />
        )}
        <span className={`text-sm font-semibold ${isApproved ? "text-emerald-300" : "text-amber-300"}`}>
          {isApproved ? "Human Approval Granted" : "Awaiting Human Approval"}
        </span>
      </div>

      {/* Descriptive text with field count */}
      <p className="mt-2 text-xs leading-relaxed text-neutral-400">
        {node.fieldCount != null
          ? `${node.fieldCount} fields extracted from title PDF. `
          : "Fields extracted from title PDF. "}
        {isApproved
          ? "Data approved — proceeding to form filling."
          : "Review the extracted data before proceeding to form filling."}
      </p>

      {/* Review & Approve action button — hidden once approved */}
      {node.status === "waiting" && (
        <button
          type="button"
          onClick={handleReviewClick}
          aria-label="Review and approve extracted fields"
          className="mt-3 inline-flex items-center gap-1.5 rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-1 focus:ring-offset-neutral-900"
        >
          <Check className="h-3 w-3" />
          Review &amp; Approve
        </button>
      )}
    </div>
  );
}

/**
 * ProducingNodeView — blue action card for final output (ZIP download).
 *
 * Visual behavior:
 *   - Always expanded (never auto-collapses)
 *   - Download icon in green to indicate ready output
 *   - "Download Packet" button links to the ZIP download endpoint
 *
 * Accessibility:
 *   - Download link has descriptive aria-label
 *   - Focus ring for keyboard users
 */
function ProducingNodeView({ node }: { node: ProducingNode }) {
  return (
    <div className="rounded-md border border-emerald-800/40 bg-emerald-950/30 p-3">
      {/* Header with download icon */}
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 shrink-0 text-emerald-400" />
        <span className="text-sm font-semibold text-emerald-300">
          ZIP Packet Ready
        </span>
      </div>

      {/* Description */}
      <p className="mt-2 text-xs leading-relaxed text-neutral-400">
        Filled HCD forms have been packaged and are ready for download.
      </p>

      {/* Download action button */}
      <a
        href={node.downloadUrl}
        aria-label="Download filled HCD forms ZIP packet"
        className="mt-3 inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-1 focus:ring-offset-neutral-900"
      >
        <Download className="h-3 w-3" />
        Download Packet
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScrollToBottomButton — floating pill visible when user scrolls up.
// Clicking scrolls to bottom and re-enables auto-scroll.
// ---------------------------------------------------------------------------

function ScrollToBottomButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="sticky bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-neutral-600 bg-neutral-800 px-3 py-1 text-xs text-neutral-300 shadow-lg transition-colors hover:bg-neutral-700"
      aria-label="Scroll to latest events"
    >
      <ArrowDown className="h-3 w-3" />
      New events
    </button>
  );
}
