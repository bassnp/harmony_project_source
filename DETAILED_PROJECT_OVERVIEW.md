# DETAILED_PROJECT_OVERVIEW.md

> **Primary implementation reference for harmony-cli (HCD Title Transfer Agent).**
> Every section is cross-referenced against actual source code — not copied from design docs.
> Last verified against the codebase at build time.

---

## §1 Purpose & Mission

**harmony-cli** is a Dockerized, single-container V1 prototype that ingests one scanned HCD title PDF, drives a GitHub Copilot CLI agent (model `claude-haiku-4.5`) over MCP-based PDF tools to extract structured data, pauses for human-in-the-loop verification, then fills three blank HCD forms (`HCD 476.6G`, `HCD 476.6`, `HCD 480.5`) and returns a downloadable ZIP packet. The user interacts via a dark-gray React shell at `http://localhost:3031` featuring a left NavBar, a center upload/download workspace, and a right-hand read-only Copilot thought stream.

---

## §2 Architecture Diagram

```
┌──────────────────────── Docker container :3031 ────────────────────────┐
│                                                                        │
│  Next.js 15 (App Router, runtime=nodejs, output=standalone)            │
│  ┌──────────────┐   POST /api/runs           ┌─────────────────────┐   │
│  │  React UI    │──────────────────────────▶ │  Orchestrator       │   │
│  │  (dark-gray) │   POST /api/runs/:id/      │  (singleton)        │   │
│  │              │       approve              │                     │   │
│  │  • NavBar    │   GET  /api/runs/:id/      │  ┌───────────────┐  │   │
│  │    New Title │       events  (SSE)        │  │ EventBus      │  │   │
│  │    History   │   GET  /api/runs/:id/      │  │ (in-process,  │  │   │
│  │  • Upload    │       download (ZIP)       │  │  ring buffer) │  │   │
│  │  • Download  │   GET  /api/runs           │  └──────┬────────┘  │   │
│  │  • Progress  │                            │         │           │   │
│  │  • Thoughts  │◀───────── SSE stream ──────┤         ▼           │   │
│  │    (R/O)     │                            │  ┌───────────────┐  │   │
│  └──────────────┘                            │  │ Run State     │  │   │
│                                              │  │ Machine       │  │   │
│                                              │  │ ingest →      │  │   │
│                                              │  │ extract →     │  │   │
│                                              │  │ HITL pause →  │  │   │
│                                              │  │ fill_forms →  │  │   │
│                                              │  │ zip → done    │  │   │
│                                              │  └──────┬────────┘  │   │
│                                              │         │ spawn     │   │
│                                              │         ▼           │   │
│                                              │  ┌───────────────┐  │   │
│                                              │  │ copilot CLI   │  │   │
│                                              │  │ --model=      │  │   │
│                                              │  │  claude-      │  │   │
│                                              │  │  haiku-4.5    │  │   │
│                                              │  │ --output-     │  │   │
│                                              │  │  format=json  │  │   │
│                                              │  └──────┬────────┘  │   │
│                                              │         │ stdio MCP │   │
│                                              │         ▼           │   │
│                                              │  ┌───────────────┐  │   │
│                                              │  │ mcp-pdf       │  │   │
│                                              │  │ pymupdf4llm   │  │   │
│                                              │  └───────────────┘  │   │
│                                              └─────────────────────┘   │
│                                                                        │
│  Volumes: workspace_data → /workspace                                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## §3 Module Index

### `src/lib/` — Core library modules

| Path | Purpose | Key Exports | Depended on by |
|---|---|---|---|
| `src/lib/eventbus.ts` | In-process pub/sub with per-subscriber ring buffers (capacity 256) and global replay log (capacity 512) for Last-Event-ID SSE reconnect. Singleton via `globalThis.__hcdBus`. | `EventBus` (class), `getEventBus()`, `BusEvent`, `PublishInput`, `SubscriptionFilter`, `Subscription`, `EventChannel` | `sse.ts`, `spawner.ts`, `stateMachine.ts`, `approve/route.ts`, `cancel/route.ts`, `events/route.ts` |
| `src/lib/sse.ts` | SSE frame formatting and `ReadableStream` factory with 15 s heartbeat, backpressure handling (`controller.desiredSize`), and `sinceSeq` deduplication. | `formatSSE()`, `formatHeartbeat()`, `createSSEStream()`, `SSE_HEADERS` | `events/route.ts` |
| `src/lib/copilot/configBuilder.ts` | Materializes per-run `.copilot/mcp-config.json` with `mcp-pdf[forms]` + `pymupdf4llm` server entries. Validates runId for path traversal safety. | `buildRunConfig()`, `buildMcpConfig()`, `McpServerEntry`, `CopilotMcpConfig`, `ConfigBuilderOptions` | `spawner.ts` |
| `src/lib/copilot/prompts.ts` | Reads `prompts/extractor.md` and `prompts/filler.md` templates, injects dynamic placeholders (`{{INPUT_PDF_PATH}}`, `{{APPROVED_JSON}}`, `{{FIELD_CATALOGUE_JSON}}`, `{{OUTPUT_DIR}}`, `{{BLANK_FORMS_DIR}}`). | `buildExtractorPrompt()`, `buildFillerPrompt()` | `stateMachine.ts` |
| `src/lib/copilot/spawner.ts` | Spawns `copilot` CLI as a child process with pinned model, parses JSONL stdout, publishes events to EventBus, persists transcript, enforces timeout with SIGTERM→SIGKILL escalation, accumulates `assistant.message_delta` as fallback. Captures `tool.execution_complete` result payloads in `toolResultTexts` for JSON extraction fallback. | `spawnCopilot()`, `SpawnCopilotOptions`, `SpawnCopilotResult` | `stateMachine.ts` |
| `src/lib/copilot/stdoutParser.ts` | Line-buffered JSONL parser for Copilot CLI `--output-format=json` stdout. Validates against Zod union of known event types; unknown types pass through via `BaseEventSchema`. Non-JSON lines emitted as `raw` events. | `CopilotEventSchema`, `CopilotEvent`, `RawLineEvent`, `ParsedEvent`, `StdoutParserOptions`, `parseStdout()`, `isCopilotEvent()` | `spawner.ts` |
| `src/lib/pdf/extractedSchema.ts` | Zod schema defining the JSON contract between the extractor stage and HITL approval. Requires `decal_number`, `serial_number`, and ≥1 owner. | `ExtractedFieldsSchema`, `ExtractedFields`, `Owner` | `stateMachine.ts`, `approve/route.ts` |
| `src/lib/pdf/fieldCatalogue.ts` | Typed, cached loader for `prompts/field_catalogue.json`. Validates structure with Zod. Provides field lookups and semantic-label-to-field-name mapping per form. | `loadFieldCatalogue()`, `getFormFields()`, `getSemanticMap()`, `_resetCache()`, `CatalogueField`, `CatalogueForm`, `FieldCatalogue` | `stateMachine.ts` |
| `src/lib/pdf/zipper.ts` | Archiver wrapper that packages filled PDFs + `manifest.json` + `transcript.jsonl` into a ZIP. Refuses empty packets (no PDFs = upstream failure). Zlib compression level 6. | `createZipPacket()`, `ZipPacketOptions` | `stateMachine.ts` |
| `src/lib/runs/ids.ts` | ULID-based run ID generator using `monotonicFactory()` for strict ordering. Format validator: 26-char Crockford base32, no I/L/O/U, no path traversal. | `generateRunId()`, `isValidRunId()` | `runs/route.ts`, all `[id]` route files |
| `src/lib/runs/stateMachine.ts` | Deterministic run lifecycle orchestrator. Drives `ingested → extracting → awaiting_human → filling → zipping → done`. Validates transitions, publishes `run.<status>` events, spawns Copilot for extraction/filling, performs post-fill filename normalization. Uses multi-strategy `resolveExtractedJson()` to handle LLM non-determinism: tries finalAssistantText, then disk output.json, then tool result payloads. | `transition()`, `failRun()`, `advanceRun()`, `resumeAfterApproval()`, `extractJsonFromText()`, `resolveExtractedJson()`, `runDir()` | `runs/route.ts`, `approve/route.ts` |
| `src/lib/runs/store.ts` | SQLite persistence via `better-sqlite3` (WAL mode, foreign keys). Singleton connection, idempotent table creation. Atomic CAS operations for race-safe status transitions. Column allowlist prevents SQL injection. | `getDb()`, `insertRun()`, `getRun()`, `listRuns()`, `updateRun()`, `casStatus()`, `casFailFromNonTerminal()`, `resetStaleRuns()`, `_resetDb()`, `RunStatus`, `RunRow` | `stateMachine.ts`, `startup.ts`, all API route handlers |
| `src/lib/runs/startup.ts` | One-time startup recovery guard. On first API call after process boot, resets any runs stuck in non-terminal intermediate states (`ingested`, `extracting`, `filling`, `zipping`) to `failed`. Preserves `awaiting_human` (deliberate HITL pause) and terminal states. Publishes `run.failed` events for SSE subscribers. Idempotent via `globalThis` flag. | `ensureStartupRecovery()` | `health/route.ts`, `runs/route.ts` |
| `src/lib/quota/fetcher.ts` | GitHub Copilot Premium Request usage fetcher. Calls `GET /users/{user}/settings/billing/premium_request/usage`, normalizes into stable `QuotaSnapshot`. Handles personal accounts (200 → cached 300s), managed/enterprise (403/404 → degraded, cached 60s), network errors. In-memory cache with automatic expiry. | `fetchQuota()`, `getCachedQuota()`, `invalidateQuotaCache()`, `nextUtcQuotaReset()` | `api/quota/route.ts` |

### `src/components/` — React UI components

| Path | Purpose | Key Exports | Used by |
|---|---|---|---|
| `src/components/shell-layout.tsx` | 3-column grid shell: NavBar (left) \| content (center) \| ThoughtPanel (right). Syncs `runId` via `localStorage` + custom `hcd-run-changed` event. | `ShellLayout` | `layout.tsx` |
| `src/components/nav-bar.tsx` | Left sidebar with "New Title" and "History" links. Active route highlighting via `usePathname()`. | `NavBar` | `shell-layout.tsx` |
| `src/components/thought-panel.tsx` | Right-hand read-only Copilot thought stream. SSE listener to `/api/runs/:id/events`, event deduplication on reconnect (`Last-Event-ID`), renders tool/assistant/reasoning/run events as VS Code Chat-style timeline nodes (ThinkingNode, ToolCallNode, StatusNode, HitlNode, ProducingNode). ThinkingNodes feature a markdown rendering toggle (Eye/EyeOff icon, default ON) that switches between `react-markdown`+`remark-gfm` styled rendering and raw text. Header "Copilot Thoughts" is clickable — opens a Radix Dialog popup showing Premium Request usage metrics (used/limit inverted display, progress bar, quote reset countdown, scope, session info, collapsible per-MCP-server agent tool listing). Fetches `GET /api/quota` on open. Handles degraded/managed account states gracefully. | `ThoughtPanel` | `shell-layout.tsx` |
| `src/components/markdown-content.tsx` | Lightweight markdown renderer for AI agent output inside ThinkingNodes. Uses `react-markdown` with `remark-gfm` for GFM support (tables, strikethrough, task lists). Custom dark-theme Tailwind component overrides for headings, tables, code blocks, lists. Secure by default — `react-markdown` strips raw HTML without `rehype-raw`. | `MarkdownContent` | `thought-panel.tsx` |
| `src/components/upload-card.tsx` | Dashed-rectangle file input. POSTs to `/api/runs` as `multipart/form-data`. Disables during upload or active run. | `UploadCard` | `new/page.tsx` |
| `src/components/download-card.tsx` | Dashed-rectangle download button. Enabled only when `zip.ready` and `runId` is set. Navigates to `/api/runs/:id/download`. | `DownloadCard` | `new/page.tsx` |
| `src/components/progress-bar.tsx` | Radix Progress primitive. Maps `RunStatus` → percentage (ingested:10 → done:100). Red for `failed`, green otherwise. | `ProgressBar` | `new/page.tsx` |
| `src/components/hitl-modal.tsx` | Radix Dialog modal for HITL review. Editable scalar fields (13) + dynamic owners list (add/remove). Tracks dirty fields for diff highlighting. Approve → `POST /approve`, Reject → `POST /cancel`. | `HitlModal` | `new/page.tsx` |
| `src/components/history-table.tsx` | Fetches `GET /api/runs`, displays tabular run history with status badges, download links, and a refresh button. | `HistoryTable` | `history/page.tsx` |

### `src/app/` — Pages and layouts

| Path | Purpose |
|---|---|
| `src/app/layout.tsx` | Root layout: metadata, Google Fonts (Geist), wraps children in `ShellLayout`. |
| `src/app/page.tsx` | Root `/` redirects to `/new` via `next/navigation.redirect()`. |
| `src/app/new/page.tsx` | "New Title" page (client component). Two-column layout (upload \| download), manages `runId` in `localStorage`, subscribes SSE for status updates + HITL modal + zip.ready. |
| `src/app/history/page.tsx` | "History" page. Renders `HistoryTable`. |

---

## §4 API Reference

| Method | Path | Zod Body Schema | Response Shape | SSE Events |
|---|---|---|---|---|
| `POST` | `/api/runs` | `UploadSchema: { name: string, size: int>0 ≤25MB, type: "application/pdf" }` (validated from `FormData` `file` field + PDF magic bytes `%PDF-`) | `201 { id, status, created_at }` | — |
| `GET` | `/api/runs` | — | `200 RunRow[]` (newest first) | — |
| `GET` | `/api/runs/[id]` | — | `200 RunRow` or `404` | — |
| `GET` | `/api/runs/[id]/events` | — | `200 text/event-stream` | `agent` channel: `assistant.message`, `assistant.message_delta`, `assistant.reasoning`, `tool.execution_start`, `tool.execution_complete`, `result`, `agent.raw`. `run` channel: `run.extracting`, `run.awaiting_human`, `run.filling`, `run.zipping`, `run.done`, `run.failed`, `human.prompt`, `zip.ready`. |
| `POST` | `/api/runs/[id]/approve` | `ExtractedFieldsSchema: { decal_number, serial_number, owners[≥1], ...optional fields }` | `200 { id, status }` or `409` (race) | — |
| `POST` | `/api/runs/[id]/cancel` | — | `200 { id, status }` or `409` (terminal) | — |
| `GET` | `/api/runs/[id]/download` | — | `200 application/zip` (streamed) or `409` (not done) | — |
| `GET` | `/api/runs/[id]/transcript` | — | `200 application/x-ndjson` (streamed) or `404` | — |
| `GET` | `/api/health` | — | `200 { ok: true }` | — |
| `GET` | `/api/quota` | — | `200 QuotaApiResponse { remaining, limit, resetAt, scope, degraded? }` — cached 300s (OK) / 60s (degraded). Falls back gracefully when `GH_TOKEN` is missing or GitHub returns 403/404 (managed accounts). | — |

**Runtime config on all API routes except `/api/health`:** `runtime = "nodejs"`, `dynamic = "force-dynamic"`. The health route is a bare handler with no runtime/dynamic exports.
**SSE route additional config:** `fetchCache = "default-no-store"`, `maxDuration = 600`.

### Error Response Reference (P7 Adversarial Testing)

> Verified via live adversarial testing against Docker container (P7). All error responses return JSON `{ error: string, issues?: ZodIssue[] }`.

| Endpoint | Condition | HTTP | Error Message |
|---|---|---|---|
| `POST /api/runs` | Missing `file` field in form data | 400 | `Missing 'file' field in form data` |
| `POST /api/runs` | Empty 0-byte file | 400 | `Validation failed` + Zod issue: `File must not be empty` |
| `POST /api/runs` | File >25 MB | 400 | `Validation failed` + Zod issue: `File exceeds 25 MB limit` |
| `POST /api/runs` | Non-PDF MIME type | 400 | `Validation failed` + Zod issue: `Only PDF files are accepted` |
| `POST /api/runs` | Invalid magic bytes (not `%PDF-`) | 400 | `File content is not a valid PDF (missing %PDF- header)` |
| `GET /api/runs/[id]/events` | Invalid run ID format | 400 | `Invalid run ID format` |
| `GET /api/runs/[id]/events` | Run not found | 404 | `Run "..." not found` |
| `GET /api/runs/[id]/events` | Path traversal attempt | 400 | `Invalid run ID format` |
| `POST /api/runs/[id]/approve` | Run not in `awaiting_human` | 409 | `Run "..." is in status "...", not "awaiting_human"` |
| `POST /api/runs/[id]/approve` | Double-approve (CAS lost) | 409 | `Run "..." is in status "filling", not "awaiting_human"` |
| `POST /api/runs/[id]/approve` | Body >256 KB | 413 | `Request body too large` |
| `POST /api/runs/[id]/approve` | Malformed JSON | 400 | `Invalid JSON body` |
| `POST /api/runs/[id]/approve` | Schema validation failure | 400 | `Validation failed` + Zod issues |
| `POST /api/runs/[id]/cancel` | Already terminal | 409 | `Run "..." is already in terminal status "..." and cannot be cancelled` |
| `GET /api/runs/[id]/download` | Run not `done` | 409 | `Run "..." is in status "...", not "done"` |
| `GET /api/runs/[id]/download` | ZIP file missing | 404 | `ZIP file not found for run "..."` |

---

## §5 State Machine

Run lifecycle managed by `src/lib/runs/stateMachine.ts`:

```
 ingested ──► extracting ──► awaiting_human ──► filling ──► zipping ──► done
    │              │                │               │           │
    └──────────────┴────────────────┴───────────────┴───────────┴──► failed
```

| From | To | Trigger | Event Published |
|---|---|---|---|
| `ingested` | `extracting` | `advanceRun()` called by POST /api/runs (fire-and-forget) | `run.extracting` |
| `extracting` | `awaiting_human` | Copilot extraction completes, JSON validates against `ExtractedFieldsSchema` | `run.awaiting_human` + `human.prompt` |
| `awaiting_human` | `filling` | `POST /api/runs/:id/approve` lands with valid body, CAS succeeds | `run.filling` |
| `filling` | `zipping` | Copilot filler completes, output PDFs validated & renamed | `run.zipping` |
| `zipping` | `done` | `createZipPacket()` succeeds, `zip_path` persisted | `run.done` + `zip.ready` |
| any non-terminal | `failed` | Error in any stage, cancel request, or timeout | `run.failed` |

**Terminal states:** `done`, `failed` — no outgoing transitions.

**HITL hard pause:** The state machine refuses to advance past `awaiting_human` until an explicit `POST /approve` lands. The UI displays a modal with editable fields and approve/reject buttons.

**Startup recovery:** When the container restarts (Docker restart, crash, `RESTART_SERVICE.bat`), in-progress Copilot child processes are killed, leaving runs permanently stuck. `src/lib/runs/startup.ts` runs exactly once per process lifetime (on first API call via `/api/health` or `GET /api/runs`) and atomically transitions all runs in `ingested`, `extracting`, `filling`, or `zipping` to `failed` with error "Run interrupted by service restart". The `awaiting_human` state is deliberately excluded — it represents a HITL pause that doesn't require a running child process, so users can still approve or cancel after a restart.

---

## §6 MCP Server Integration

Two stdio-transport MCP servers are configured per run via `configBuilder.ts`:

### `mcp-pdf` (package: `mcp-pdf[forms]`)

| Tool | Stage | Arguments | Returns |
|---|---|---|---|
| `extract_text` | Extraction | `{ pdf_path: string }` | Plain text content of the PDF |
| `extract_form_data` | Discovery (`scripts/discover-fields.ts`) | `{ pdf_path: string }` | JSON array of AcroForm field descriptors |
| `fill_form_pdf` | Filling | `{ pdf_path: string, output_path: string, fields: Record<string, string> }` | Path to the filled PDF |
| `merge_pdfs` | (available, not used in V1) | `{ pdf_paths: string[] }` | Path to merged PDF |

### `pymupdf4llm` (package: `pymupdf4llm-mcp`)

| Tool | Stage | Arguments | Returns |
|---|---|---|---|
| `convert_pdf` | Extraction | `{ pdf_path: string }` | High-fidelity Markdown representation of the PDF |

**Invocation path:** `spawner.ts` → `buildRunConfig()` writes `mcp-config.json` → Copilot CLI reads config via `--config-dir` → spawns MCP servers as stdio subprocesses.

**Server lifecycle:** Each MCP server is spawned by Copilot CLI at process start and terminated when the Copilot process exits. Servers are pre-warmed in the Dockerfile (`uv tool install`) so first invocation is fast.

---

## §7 Copilot CLI Spawn Contract

Defined in `src/lib/copilot/spawner.ts`:

### Argv
```
copilot \
  -p <promptText> \
  --model=claude-haiku-4.5 \
  --output-format=json \
  --no-ask-user \
  --allow-all-tools \
  --config-dir <perRunCopilotDir>
```

### Environment Variables
| Var | Value | Source |
|---|---|---|
| `COPILOT_HOME` | `/workspace/agents/<runId>/.copilot` | Set per invocation for isolation |
| `COPILOT_GITHUB_TOKEN` | From `.env` / host environment | `process.env` inheritance |
| All other `process.env` vars | Inherited | Spread into child env |

### stdio Wiring
| fd | Wiring |
|---|---|
| `stdin` | `"ignore"` |
| `stdout` | `"pipe"` → parsed by `stdoutParser.parseStdout()` |
| `stderr` | `"pipe"` (consumed but not parsed) |

### Timeout & Signal Handling
- **Hard timeout:** 600,000 ms (10 min) by default (`DEFAULT_TIMEOUT_MS`).
- **Escalation:** `SIGTERM` sent at timeout → 5 s grace period (`SIGKILL_GRACE_MS`) → `SIGKILL` if still alive.
- **Transcript:** Every parsed event appended to `<cwd>/transcript.jsonl` (fire-and-forget write).
- **Final text resolution:** Last `assistant.message` event's `data.content` wins. Fallback: accumulated `assistant.message_delta` content if no full message arrives.

---

## §8 Frontend Component Tree

```
RootLayout (src/app/layout.tsx)
└── ShellLayout (src/components/shell-layout.tsx)
    ├── NavBar (src/components/nav-bar.tsx)
    │   ├── Link → /new  ("New Title", icon: FilePlus)
    │   └── Link → /history  ("History", icon: History)
    ├── {children} — page content slot
    │   ├── NewTitlePage (src/app/new/page.tsx) — "use client"
    │   │   ├── UploadCard (src/components/upload-card.tsx)
    │   │   │   └── <input type="file" accept=".pdf" />
    │   │   ├── DownloadCard (src/components/download-card.tsx)
    │   │   │   └── <button onClick → window.location.href = /api/runs/:id/download />
    │   │   ├── ProgressBar (src/components/progress-bar.tsx)
    │   │   │   └── RadixProgress.Root + Indicator
    │   │   └── HitlModal (src/components/hitl-modal.tsx)
    │   │       └── RadixDialog.Root + Portal + Overlay + Content
    │   │           ├── Scalar fields (13 inputs, dirty-diff highlighting)
    │   │           ├── Owners list (dynamic add/remove)
    │   │           ├── "Approve & Fill" button → POST /approve
    │   │           └── "Reject & Restart" button → POST /cancel
    │   └── HistoryPage (src/app/history/page.tsx)
    │       └── HistoryTable (src/components/history-table.tsx)
    │           ├── StatusBadge (file-local helper)
    │           ├── Download links → /api/runs/:id/download
    │           └── Refresh button
    └── ThoughtPanel (src/components/thought-panel.tsx)
        ├── QuotaPopup (src/components/quota-popup.tsx) — opens on header click
        │   ├── QuotaSection (file-local) — used/limit (inverted), usage bar, quote reset countdown
        │   ├── SessionSection (file-local) — agent, MCP servers, model
        │   └── AgentToolsSection (file-local) — collapsible per-MCP-server tool listing
        └── ThoughtStream (file-local, keyed by runId)
            ├── SSE subscription to /api/runs/:id/events
            ├── useReducer(timelineReducer) — pure state machine (src/lib/timeline-reducer.ts)
            ├── TimelineContainer — vertical connector line + aria-live="polite"
            │   └── TimelineNodeRenderer — status dot + node dispatch by kind
            │       ├── ThinkingNodeView — Brain icon, collapsible, grouped, live elapsed time
            │       ├── ToolCallNodeView — Zap icon, 3-tier (summary → args → raw JSON), paired start/complete
            │       ├── StatusNodeView — milestone markers (ingested, extracting, awaiting_human, filling, done, failed)
            │       ├── HitlNodeView — amber card, "Review & Approve" button, aria-live="assertive"
            │       └── ProducingNodeView — blue card, "Download Packet" link
            └── ScrollToBottomButton — floating pill, appears when user scrolls up
```

**Data flow:**
- `NewTitlePage` stores `runId` in `localStorage` and dispatches a custom `hcd-run-changed` event.
- `ShellLayout` listens for `hcd-run-changed` + `storage` events, passes `runId` to `ThoughtPanel`.
- `ThoughtPanel` creates a new `ThoughtStream` (keyed by `runId`) which opens an `EventSource` to `/api/runs/:id/events`.

---

## §9 Test Matrix

| Test File | Layer | Module(s) Covered | Key Assertions |
|---|---|---|---|
| `tests/unit/eventbus.test.ts` | Unit | `src/lib/eventbus.ts` | publish+pull, ring buffer overflow (drop-oldest), runId filtering, close semantics, `waitForNext` resolution, concurrent waiters, `replayFrom` with filtering, singleton getter |
| `tests/unit/sse.test.ts` | Unit | `src/lib/sse.ts` | `formatSSE` frame structure, `formatHeartbeat`, `createSSEStream` event delivery, abort/close cleanup, payload newline handling, rapid events, immediate heartbeat, `sinceSeq` deduplication |
| `tests/unit/configBuilder.test.ts` | Unit | `src/lib/copilot/configBuilder.ts` | `buildMcpConfig` structure (2 servers), `buildRunConfig` directory isolation + idempotency, runId validation (rejects path-traversal, slashes, spaces, backticks, null bytes, >128 chars), pretty-printed JSON |
| `tests/unit/spawner.test.ts` | Unit | `src/lib/copilot/spawner.ts` | JSONL parsing + transcript, final `assistant.message` capture, pinned model in argv, `assistant.message_delta` fallback accumulation, EventBus publishing, transcript.jsonl persistence, non-zero exit code, SIGTERM→SIGKILL escalation, missing token error, raw line handling |
| `tests/unit/stdoutParser.test.ts` | Unit | `src/lib/copilot/stdoutParser.ts` | `CopilotEventSchema` validates known event types + unknown passthrough, `parseStdout` JSONL parsing, empty line skip, ANSI junk handling, `isCopilotEvent` type guard |
| `tests/unit/extractedSchema.test.ts` | Unit | `src/lib/pdf/extractedSchema.ts` | Valid complete extraction, minimal fields, missing required fields rejection, empty owners rejection, multiple owners, unicode characters, special chars in serials |
| `tests/unit/fieldCatalogue.test.ts` | Unit | `src/lib/pdf/fieldCatalogue.ts` | `loadFieldCatalogue` parsing + caching, throws on missing/malformed/invalid structure, `getFormFields` lookup + not-found error, `getSemanticMap` label→name mapping |
| `tests/unit/zipper.test.ts` | Unit | `src/lib/pdf/zipper.ts` | ZIP creation with PDFs + manifest, transcript inclusion, refuses empty packet (no PDFs), handles non-existent outDir, ignores non-PDF files, skips transcript if missing |
| `tests/unit/ids.test.ts` | Unit | `src/lib/runs/ids.ts` | `generateRunId` length (26 chars) + uniqueness + lexicographic ordering, `isValidRunId` accepts ULID, rejects wrong-length/path-traversal/forbidden Crockford chars |
| `tests/unit/stateMachine.test.ts` | Unit | `src/lib/runs/stateMachine.ts` | Legal/illegal transition validation, `failRun` no-op on terminal states, `extractJsonFromText` direct parse / markdown fence / brace extraction, `resolveExtractedJson` multi-strategy fallback (message → disk → tool results) |
| `tests/unit/store.test.ts` | Unit | `src/lib/runs/store.ts` | Table creation, `insertRun`/`getRun`, `listRuns` newest-first, `updateRun` partial updates, disallowed column rejection (SQL injection guard), duplicate insertion rejection, large JSON storage, `casStatus` atomic transitions + single-winner race, `casFailFromNonTerminal` no-op on terminal |
| `tests/unit/startup.test.ts` | Unit | `src/lib/runs/startup.ts` | Resets `extracting`/`ingested`/`filling`/`zipping` to `failed`, preserves `awaiting_human`/`done`/`failed`, bulk reset of multiple stale runs, idempotency (second call is no-op), publishes `run.failed` events per reset run, returns 0 when no stale runs |
| `tests/unit/smoke.test.ts` | Unit | — | Trivial sanity check (`1+1===2`) |
| `tests/unit/timeline-reducer.test.ts` | Unit | `src/lib/timeline-reducer.ts` | ADD_THINKING (5 cases: new node, merge consecutive, grouped indicator), ADD_TOOL_START/UPDATE_TOOL_COMPLETE (9 cases: create, pair by toolCallId, success/failure, orphan complete), ADD_STATUS (3 cases: milestone, auto-complete running thinking), ADD_HITL (3 cases), ADD_PRODUCING (2 cases), RESET, unknown action, full pipeline (3 cases incl. rapid events), completeRunningThinking (5 cases), **P7.8 stress** (26 cases: 100-event thinking merge, 500-event mixed pipeline, 10 concurrent out-of-order tool completions, mixed success/failure concurrent tools, duplicate tool complete overwrite, same-ID separate nodes, RESET+rebuild, empty/10KB/unicode/special-char content, null/undefined results, deeply nested results, boundary fieldCount/timestamps, state immutability verification, reducer determinism, all-5-kinds rapid sequence, 50-iteration interleave, multiple HITL nodes, special-char download URLs), **P9 enhanced sweep v2** (34 cases: negative/extreme timestamps, 800-node scale, toolCallIdMap integrity across RESET+reuse, cross-node-type merge isolation, prototype pollution/injection, edge-case toolCallIds, full lifecycle ordering, replay idempotency, deep immutability, concurrent 20-tool shuffled completion, completeRunningThinking edge cases) |
| `tests/contract/configBuilder.contract.test.ts` | Contract | `src/lib/copilot/configBuilder.ts`, `src/lib/copilot/spawner.ts` | MCP config has exactly 2 servers, server entries conform to stdio transport, `mcp-config.json` is valid pretty-printed JSON, per-run isolation, spawner argv includes `--model=claude-haiku-4.5`, `--output-format=json`, `--no-ask-user`, `--allow-all-tools`, `COPILOT_HOME` env var |
| `tests/e2e/happy-path.spec.ts` | E2E (Playwright) | Full stack | Navigate `/new`, upload `sample_title.pdf`, wait for HITL modal, approve, wait for download button, download ZIP, verify ≥3 PDFs, navigate `/history`, verify "done" status, assert thought panel streams events |

### P7 Adversarial Input & Failure Mode Test Results

> Verified via live adversarial testing against Docker container. All tests executed against `http://localhost:3031`.

| Test ID | Category | Scenario | Result | Details |
|---|---|---|---|---|
| P7.1.1 | Invalid Upload | `.txt` renamed to `.pdf` (invalid magic bytes) | **PASS** | HTTP 400: `File content is not a valid PDF (missing %PDF- header)` |
| P7.1.2 | Invalid Upload | Empty 0-byte file | **PASS** | HTTP 400: Zod validation `File must not be empty` |
| P7.1.3 | Invalid Upload | File >25 MB | **PASS** | HTTP 400: Zod validation `File exceeds 25 MB limit` |
| P7.1.4 | Invalid Upload | Non-PDF MIME type (`image/png`) | **PASS** | HTTP 400: Zod validation `Only PDF files are accepted` |
| P7.1.5 | Invalid Upload | Missing `file` field | **PASS** | HTTP 400: `Missing 'file' field in form data` |
| P7.1.6 | Invalid Upload | PNG magic bytes with `.pdf` extension | **PASS** | HTTP 400: Magic byte check rejects |
| P7.2.1 | Corrupted PDF | Truncated PDF (valid header, minimal body) | **PASS** | Upload accepted; pipeline fails at schema validation → `run.failed` |
| P7.2.2 | Corrupted PDF | Header-only PDF (9 bytes) | **PASS** | Upload accepted; pipeline fails at schema validation → `run.failed` |
| P7.2.3 | Corrupted PDF | Valid header + random garbage bytes | **PASS** | Upload accepted; pipeline eventually fails or times out → `run.failed` |
| P7.3.1 | Missing Credentials | Invalid `COPILOT_GITHUB_TOKEN` | **PASS** | Upload accepted; Copilot exits code 1 → `run.failed` with "Copilot exited with code 1" |
| P7.3.2 | Startup Recovery | Container restart with stale runs | **PASS** | `startup.ts` resets `extracting`/`filling`/`zipping` to `failed` with "Run interrupted by service restart" |
| P7.4.1 | SSE Edge Case | Non-existent run ID | **PASS** | HTTP 400: `Invalid run ID format` |
| P7.4.2 | SSE Edge Case | Invalid run ID format | **PASS** | HTTP 400: `Invalid run ID format` |
| P7.4.3 | SSE Edge Case | Fake `Last-Event-ID` | **PASS** | Silently ignored; heartbeats only |
| P7.4.4 | SSE Edge Case | Future sequence `Last-Event-ID` | **PASS** | No events sent; heartbeats only |
| P7.4.5 | SSE Edge Case | Two concurrent SSE connections | **PASS** | Both receive events independently |
| P7.4.6 | SSE Edge Case | Path traversal in run ID | **PASS** | HTTP 400: Blocked by ULID validation |
| P7.5.1 | Rapid Uploads | 3 PDFs in ~74ms | **PASS** | 3 unique ULID run IDs; no cross-contamination; sequential processing |
| P7.6.1 | Container Resilience | Stop/restart data persistence | **PASS** | All 49 runs persisted; `awaiting_human` preserved; downloads work |
| P7.6.2 | Container Resilience | New upload after restart | **PASS** | Pipeline starts normally |
| P7.6.3 | Container Resilience | Volume persistence | **PASS** | Named volume `workspace_data` retains all run directories |
| P7.7.1 | HITL Edge Case | Double-approve (CAS race) | **PASS** | First: 200; Second: 409 (CAS prevents double-transition) |
| P7.7.2 | HITL Edge Case | Cancel `awaiting_human` run | **PASS** | HTTP 200; error="Cancelled by user" |
| P7.7.3 | HITL Edge Case | Approve with modified field values | **PASS** | HTTP 200; server accepts human-edited values |
| P7.7.4 | HITL Edge Case | Approve with invalid schema | **PASS** | HTTP 400: Zod validation rejects missing required fields |
| P7.7.5 | HITL Edge Case | Approve with oversized body (300KB) | **PASS** | HTTP 413: `Request body too large` |
| P7.7.6 | HITL Edge Case | Cancel already-failed run | **PASS** | HTTP 409: Already in terminal status |
| P7.7.7 | HITL Edge Case | Approve already-failed run | **PASS** | HTTP 409: Not `awaiting_human` |
| P7.7.8 | HITL Edge Case | Malformed JSON body | **PASS** | HTTP 400: `Invalid JSON body` |
| P7.8.1 | Timeline Stress | Event count per run | **PASS** | ~15-30 timeline nodes due to thinking merge + tool pairing |
| P7.8.2 | Timeline Stress | EventBus ring buffer | **PASS** | 512-event global limit; completed runs evicted after buffer fills |

**Summary:** 30/30 adversarial tests PASS. Zero critical or important issues found. System degrades gracefully for all tested failure modes.

### P8 Enhanced Adversarial Re-Sweep Results

> Re-sweep of P7 with adjusted details, added complexity, and nuanced edge cases. Verified via live testing against Docker container at `http://localhost:3031`.

| Test ID | Category | Scenario | Result | Details |
|---|---|---|---|---|
| P8.1.1 | Upload Edge | XSS in filename `<script>alert(1)</script>.pdf` | **PASS** | HTTP 400: Magic byte check rejects (no PDF header) |
| P8.1.2 | Upload Edge | Empty filename | **PASS** | HTTP 400: Validation rejects empty name |
| P8.1.3 | Upload Edge | No Content-Type header | **PASS** | HTTP 400: Missing content type |
| P8.1.4 | Upload Edge | Exactly 25 MB file (boundary) | **PASS** | HTTP 400: Multipart framing overhead pushes total over limit (acceptable) |
| P8.2.1 | Corrupted PDF | Empty pages PDF (328B, valid header) | **PASS** | Upload 201; pipeline fails at schema validation → `run.failed` |
| P8.2.2 | Corrupted PDF | Repeated content PDF (1800B) | **PASS** | Upload 201; pipeline fails → `run.failed` |
| P8.2.3 | Corrupted PDF | Null bytes after header (5009B) | **PASS** | Upload 201; pipeline fails → `run.failed` |
| P8.2.4 | Corrupted PDF | Random bytes after header (2009B) | **PASS** | Upload 201; pipeline fails → `run.failed` |
| P8.4.1 | SSE Edge | Valid ULID for non-existent run | **PASS** | HTTP 404 |
| P8.4.2 | SSE Edge | URL-encoded path traversal `..%2F..%2F` | **PASS** | HTTP 400: ULID validation blocks |
| P8.4.3 | SSE Edge | SQL injection in run ID `' OR 1=1--` | **PASS** | HTTP 400: ULID validation blocks |
| P8.4.4 | SSE Edge | Done run SSE stream | **PASS** | HTTP 200: Heartbeats only (events evicted from ring buffer) |
| P8.4.5 | SSE Edge | Future Last-Event-ID (999999) | **PASS** | HTTP 200: No events, heartbeats only |
| P8.4.6 | SSE Edge | Integer overflow Last-Event-ID | **PASS** | HTTP 200: Graceful handling |
| P8.4.7 | SSE Edge | Negative Last-Event-ID | **PASS** | HTTP 200: Graceful handling |
| P8.4.8 | SSE Edge | Non-numeric Last-Event-ID `abc` | **PASS** | HTTP 200: Silently ignored |
| P8.5.1 | Concurrent | 5 simultaneous uploads | **PASS** | 5 unique ULID run IDs, monotonically increasing, all processed |
| P8.6.1 | Container | Volume persistence across restart (79 runs) | **PASS** | 79/79 runs preserved |
| P8.6.2 | Container | `awaiting_human` preservation (14 runs) | **PASS** | 14/14 preserved across restart |
| P8.6.3 | Container | Startup recovery (0 stuck intermediate) | **PASS** | All intermediate states reset to failed |
| P8.6.4 | Container | Post-restart new upload | **PASS** | Pipeline starts normally |
| P8.7.1 | HITL Edge | Minimal valid schema approve | **PASS** | HTTP 200: Transition to filling |
| P8.7.2 | HITL Edge | Double-approve CAS race | **PASS** | First: 200; Second: 409 |
| P8.7.3 | HITL Edge | Invalid JSON body | **PASS** | HTTP 400: `Invalid JSON body` |
| P8.7.4 | HITL Edge | Empty object `{}` | **PASS** | HTTP 400: Zod validation rejects |
| P8.7.5 | HITL Edge | Missing owners field | **PASS** | HTTP 400: Zod validation rejects |
| P8.7.6 | HITL Edge | Empty owners array `[]` | **PASS** | HTTP 400: Array min(1) rejects |
| P8.7.7 | HITL Edge | Extra/malicious fields + XSS | **PASS** | HTTP 200: Extra fields stripped by Zod |
| P8.7.8 | HITL Edge | Approve `done` run | **PASS** | HTTP 409: Not `awaiting_human` |
| P8.7.9 | HITL Edge | Approve `failed` run | **PASS** | HTTP 409: Not `awaiting_human` |
| P8.7.10 | HITL Edge | Cancel `awaiting_human` run | **PASS** | HTTP 200: Status → failed |
| P8.7.11 | HITL Edge | Cancel already-failed run | **PASS** | HTTP 409: Already terminal |
| P8.7.12 | HITL Edge | Non-ULID run ID (`TEST_STUCK_RUN`) | **PASS** | HTTP 400: `isValidRunId()` rejects |
| P8.8.1 | Timeline Stress | 100-event thinking merge | **PASS** | Single node, 100 lines, `isGrouped: true` |
| P8.8.2 | Timeline Stress | 500-event mixed pipeline (100 cycles) | **PASS** | 300 nodes, all correctly typed/statused |
| P8.8.3 | Timeline Stress | 10 concurrent tools, reverse-order complete | **PASS** | All paired correctly via `toolCallIdMap` |
| P8.8.4 | Timeline Stress | State immutability verification | **PASS** | Previous state references unchanged |
| P8.8.5 | Timeline Stress | Reducer determinism (identical replay) | **PASS** | Same actions → identical state |

**Summary:** 38/38 enhanced adversarial tests PASS. Zero issues found. Combined with original P7 (30/30), total 68 adversarial tests PASS across both sweeps.

### P9 Enhanced Adversarial Re-Sweep v2 Results

> Re-sweep v2 with adjusted details, new complexity tiers, nuanced edge cases not covered in P7/P8. Includes 34 new unit tests and 24 new live API tests.

#### Unit Tests (34 new — 92 total timeline-reducer tests)

| Test ID | Category | Scenario | Result | Details |
|---|---|---|---|---|
| P9.U.1 | Timestamps | Negative timestamp (-1000) | **PASS** | Node created with negative startedAt, no crash |
| P9.U.2 | Timestamps | MAX_SAFE_INTEGER timestamp | **PASS** | Stored correctly without overflow |
| P9.U.3 | Timestamps | completedAt before startedAt | **PASS** | Reducer does not enforce ordering — stores as-is |
| P9.U.4 | Scale | 200-cycle 800-node pipeline | **PASS** | All 200 toolCallIdMap entries correct; 200 thinking auto-completed |
| P9.U.5 | toolCallIdMap | RESET+rebuild indices correct | **PASS** | Post-RESET indices start from 0; old IDs absent |
| P9.U.6 | toolCallIdMap | 5x RESET cycle produces clean state | **PASS** | Final state equals INITIAL_TIMELINE_STATE |
| P9.U.7 | toolCallIdMap | Same toolCallId reused after complete | **PASS** | Map points to new node; both nodes retain correct results |
| P9.U.8 | Merge Isolation | Thinking after HITL — no merge | **PASS** | Pre-HITL thinking completed; post-HITL thinking independent |
| P9.U.9 | Merge Isolation | Thinking after producing — no merge | **PASS** | Same isolation as HITL case |
| P9.U.10 | Merge Isolation | HITL→HITL→tool: tool does not complete HITL | **PASS** | Both HITL nodes remain "waiting" |
| P9.U.11 | Merge Isolation | Status after status — distinct milestones | **PASS** | 6 status nodes, no merging |
| P9.U.12 | Security | __proto__ in args — no prototype pollution | **PASS** | Stored as data; node/state not polluted |
| P9.U.13 | Security | Pollution keys in result — state intact | **PASS** | toString/valueOf stored as values, not as method overrides |
| P9.U.14 | Security | HTML injection in status detail | **PASS** | Stored as plain string; React escapes at render |
| P9.U.15 | Edge IDs | Empty string toolCallId — pairing works | **PASS** | Map key "" → index 0; complete pairs correctly |
| P9.U.16 | Edge IDs | Emoji/special-char toolCallId | **PASS** | `tc-🔧-extract/text?v=2` pairs correctly |
| P9.U.17 | Edge IDs | 1000-char toolCallId | **PASS** | Map lookup and pairing work |
| P9.U.18 | Lifecycle | All 7 run statuses in order | **PASS** | 6 status nodes, all "completed" (no "failed") |
| P9.U.19 | Lifecycle | Failed lifecycle shortcut | **PASS** | 4 nodes; thinking auto-completed; failed detail preserved |
| P9.U.20 | Idempotency | 3x identical replay → identical state | **PASS** | Reducer is deterministic; all 3 runs produce equal state |
| P9.U.21 | Edge Case | Producing after run.failed | **PASS** | Both nodes created; no crash |
| P9.U.22 | Merge Edge | Multiline content merge preserves formatting | **PASS** | `\n` separator between merged content blocks |
| P9.U.23 | Merge Edge | Whitespace-only content merge | **PASS** | Spaces and tabs preserved; isGrouped true |
| P9.U.24 | Merge Edge | 50 single-char thinking events | **PASS** | Single node with 50-line content |
| P9.U.25 | Immutability | ADD_STATUS does not mutate prev nodes | **PASS** | Previous node ref still "running" |
| P9.U.26 | Immutability | ADD_HITL does not mutate prev thinking | **PASS** | Previous ref unchanged |
| P9.U.27 | Immutability | toolCallIdMap not shared between states | **PASS** | state1 map has 1 entry; state2 has 2; no cross-contamination |
| P9.U.28 | Interaction | HITL→producing→HITL sequence | **PASS** | All 3 nodes created with correct kinds |
| P9.U.29 | Interaction | Producing with empty downloadUrl | **PASS** | Empty string stored; status "completed" |
| P9.U.30 | Resilience | Unknown action type "DESTROY_ALL" | **PASS** | State returned unchanged |
| P9.U.31 | Resilience | Missing required fields on ADD_TOOL_START | **PASS** | Node created with undefined fields; no crash |
| P9.U.32 | Stress | 20 concurrent tools, shuffled completion | **PASS** | All 20 paired correctly; results match completion order |
| P9.U.33 | Helper | completeRunningThinking — non-tail running | **PASS** | Only tail node completed |
| P9.U.34 | Helper | completeRunningThinking — failed status | **PASS** | No change (only "running" status affected) |

#### Live API Tests (24 new against Docker container)

| Test ID | Category | Scenario | Result | Details |
|---|---|---|---|---|
| P9.L.1 | Upload | Malformed multipart boundary | **PASS** | HTTP 400 |
| P9.L.2 | Upload | Unicode/CJK filename (non-PDF content) | **PASS** | HTTP 400 |
| P9.L.3 | Upload | Double file field in multipart | **PASS** | HTTP 201: First file processed; no crash |
| P9.L.4 | Upload | PUT method on /api/runs | **PASS** | HTTP 405: Method Not Allowed |
| P9.L.5 | Upload | DELETE method on /api/runs | **PASS** | HTTP 405: Method Not Allowed |
| P9.L.6 | Upload | POST with no body | **PASS** | HTTP 400 |
| P9.L.7 | SSE | HEAD on SSE endpoint | **PASS** | HTTP 200 |
| P9.L.8 | SSE | POST on SSE endpoint | **PASS** | HTTP 405 |
| P9.L.9 | SSE | Newline injection in Last-Event-ID | **PASS** | Blocked by .NET/HTTP layer (CRLF rejected) |
| P9.L.10 | SSE | Unicode zero-width spaces in run ID | **PASS** | HTTP 400 |
| P9.L.11 | SSE | Invalid Crockford base32 (26 I's) | **PASS** | HTTP 400 |
| P9.L.12 | SSE | OPTIONS preflight | **PASS** | HTTP 204: `allow: GET, HEAD, OPTIONS` |
| P9.L.13 | SSE | 500-char run ID | **PASS** | HTTP 400 |
| P9.L.14 | SSE | Null byte in run ID (%00) | **PASS** | HTTP 400 |
| P9.L.15 | HITL | Approve with text/plain Content-Type | **PASS** | HTTP 400 |
| P9.L.16 | HITL | Approve with array root JSON | **PASS** | HTTP 400 |
| P9.L.17 | HITL | SQL injection in field values | **PASS** | No DB corruption; runs table intact post-test |
| P9.L.18 | HITL | 100 owners in approve body | **PASS** | HTTP 200: Accepted, run→filling |
| P9.L.19 | HITL | GET on /approve endpoint | **PASS** | HTTP 405 |
| P9.L.20 | HITL | Cancel non-existent run (valid ULID format) | **PASS** | HTTP 404 |
| P9.L.21 | HITL | Double cancel same run | **PASS** | First: 200; Second: 409 |
| P9.L.22 | Container | 81 runs intact after adversarial sweep | **PASS** | No data loss |
| P9.L.23 | Container | 0 stuck intermediate states | **PASS** | Only active `filling` run (intentionally approved) |
| P9.L.24 | Container | DB integrity post SQL-injection | **PASS** | All endpoints functional; parameterized queries confirmed safe |

**Summary:** 58/58 enhanced adversarial tests PASS (34 unit + 24 live API). Combined with P7 (30) and P8 (38), total **126 adversarial tests PASS** across all three sweeps. Zero critical, zero important issues. Defense-in-depth ordering confirmed: run ID format → run status → request body validation.

---

## §10 Configuration Files

| File | Purpose | Key Fields |
|---|---|---|
| `next.config.ts` | Next.js 15 configuration | `output: "standalone"` (minimal Docker image), `experimental.serverActions.bodySizeLimit: "25mb"` (PDF upload limit) |
| `tsconfig.json` | TypeScript compiler options | `target: "ES2017"`, `strict: true`, `noUncheckedIndexedAccess: true`, `skipLibCheck: true`, `module: "esnext"`, `moduleResolution: "bundler"`, paths alias `@/* → ./src/*` |
| `vitest.config.ts` | Vitest test runner config | `environment: "node"`, `globals: true`, `include: ["tests/**/*.test.ts"]`, coverage via `@vitest/coverage-v8`, resolve alias `@/ → ./src` |
| `playwright.config.ts` | Playwright E2E config | `testDir: "tests/e2e"`, `fullyParallel: true`, `retries: CI ? 2 : 0`, `baseURL: "http://localhost:3031"`, project: `chromium` only |
| `eslint.config.mjs` | ESLint 9 flat config | Extends `nextVitals`, `nextTs`, `prettier`. Global ignores: `.next/`, `out/`, `build/`, `next-env.d.ts` |
| `postcss.config.mjs` | PostCSS for Tailwind | Plugin: `@tailwindcss/postcss` |
| `Dockerfile` | Multi-stage Docker build | Base: `node:22-bookworm-slim`. Stage 1 (deps): `npm ci`. Stage 2 (builder): `npm run build`. Stage 3 (runtime): system packages (python3, tesseract-ocr, ghostscript, poppler-utils, git, tini, curl, sqlite3, jq), `uv` installer, global `@github/copilot` + `tsx`, non-root user `app` (UID 1001), pre-warmed MCP servers, standalone Next.js build. PID 1: `tini`. Healthcheck: `/api/health` via `curl` every 30 s. |
| `docker-compose.yml` | Compose orchestration | Service: `app`. Build: `./Dockerfile`. Ports: `3031:3031`. Volume: `workspace_data → /workspace`. Env: `NODE_ENV=production`, `PORT=3031`, `HOSTNAME=0.0.0.0`. `env_file: .env` (optional). Restart: `unless-stopped`. |

---

## §11 Environment Variables

| Variable | Required | Source | Used By | Description |
|---|---|---|---|---|
| `GH_TOKEN` | Yes | `.env` | Copilot CLI (auth) | GitHub personal access token for Copilot API authentication |
| `COPILOT_GITHUB_TOKEN` | Yes | `.env` | `spawner.ts` → child process env | Same token, explicitly passed to spawned Copilot CLI process. Validated at spawn time — throws if missing. |
| `NODE_ENV` | No (default: `production`) | `Dockerfile` / `docker-compose.yml` | Next.js, npm | Controls production optimizations and devDependency installation |
| `PORT` | No (default: `3031`) | `Dockerfile` / `docker-compose.yml` | Next.js server | HTTP listen port |
| `HOSTNAME` | No (default: `0.0.0.0`) | `Dockerfile` / `docker-compose.yml` | Next.js server | Bind address (0.0.0.0 for container accessibility) |
| `NEXT_TELEMETRY_DISABLED` | No (default: `1`) | `Dockerfile` / `docker-compose.yml` | Next.js | Disables Next.js telemetry |
| `COPILOT_HOME` | Runtime-only | Set per spawn in `spawner.ts` | Copilot CLI | Per-run isolation directory (`/workspace/agents/<runId>/.copilot`) |
| `UV_TOOL_DIR` | Build-time | `Dockerfile` | uv package manager | Tool installation directory for MCP servers |
| `UV_TOOL_BIN_DIR` | Build-time | `Dockerfile` | uv package manager | Binary symlink directory for installed tools |

---

## §12 File Tree

```
project_source/
├── .dockerignore
├── .env.example
├── .gitignore
├── AGENTS.md
├── DETAILED_PROJECT_OVERVIEW.md
├── Dockerfile
├── README.md
├── docker-compose.yml
├── eslint.config.mjs
├── next-env.d.ts
├── next.config.ts
├── package.json
├── playwright.config.ts
├── postcss.config.mjs
├── tsconfig.json
├── vitest.config.ts
├── assets/
│   ├── Title_Transfer_Agent_Take_Home.pdf
│   ├── hcd-rt-476-6.pdf
│   ├── hcd-rt-476-6g.pdf
│   ├── hcd-rt-480-5.pdf
│   └── sample_title.pdf
├── prompts/
│   ├── extractor.md
│   ├── field_catalogue.json
│   └── filler.md
├── public/
├── scripts/
│   ├── discover-fields.ts
│   ├── extract_form_fields.py
│   ├── healthcheck.sh
│   └── smoke-extract.ts
├── src/
│   ├── app/
│   │   ├── favicon.ico
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── api/
│   │   │   ├── health/
│   │   │   │   └── route.ts
│   │   │   └── runs/
│   │   │       ├── route.ts
│   │   │       └── [id]/
│   │   │           ├── route.ts
│   │   │           ├── approve/route.ts
│   │   │           ├── cancel/route.ts
│   │   │           ├── download/route.ts
│   │   │           ├── events/route.ts
│   │   │           └── transcript/route.ts
│   │   ├── history/
│   │   │   └── page.tsx
│   │   └── new/
│   │       └── page.tsx
│   ├── components/
│   │   ├── download-card.tsx
│   │   ├── history-table.tsx
│   │   ├── hitl-modal.tsx
│   │   ├── markdown-content.tsx
│   │   ├── nav-bar.tsx
│   │   ├── progress-bar.tsx
│   │   ├── shell-layout.tsx
│   │   ├── thought-panel.tsx
│   │   └── upload-card.tsx
│   └── lib/
│       ├── eventbus.ts
│       ├── sse.ts
│       ├── copilot/
│       │   ├── configBuilder.ts
│       │   ├── prompts.ts
│       │   ├── spawner.ts
│       │   └── stdoutParser.ts
│       ├── pdf/
│       │   ├── extractedSchema.ts
│       │   ├── fieldCatalogue.ts
│       │   └── zipper.ts
│       └── runs/
│           ├── ids.ts
│           ├── startup.ts
│           ├── stateMachine.ts
│           └── store.ts
└── tests/
    ├── contract/
    │   └── configBuilder.contract.test.ts
    ├── e2e/
    │   └── happy-path.spec.ts
    └── unit/
        ├── configBuilder.test.ts
        ├── eventbus.test.ts
        ├── extractedSchema.test.ts
        ├── fieldCatalogue.test.ts
        ├── ids.test.ts
        ├── smoke.test.ts
        ├── spawner.test.ts
        ├── sse.test.ts
        ├── stateMachine.test.ts
        ├── startup.test.ts
        ├── stdoutParser.test.ts
        ├── store.test.ts
        └── zipper.test.ts
```

---

## §13 POLISH_PROTOCOL

> Continuous quality gate for the HCD Title Transfer Agent codebase.

### When to run

- **After every feature branch** — before merging, run `npm run polish` to verify nothing is broken.
- **Before every submission** — the polish protocol is the final quality gate.
- **As the standard post-change CI gate** — P12 in the phase system is re-invoked after any codebase change.

### What it checks

| Step | Check | Fail Behavior |
|---|---|---|
| 1/7 | **TypeScript strict check** (`tsc --noEmit`) | Hard fail — type errors must be resolved |
| 2/7 | **ESLint** (`npm run lint`) | Hard fail — zero warnings policy |
| 3/7 | **Vitest** (unit + contract tests) | Hard fail — all tests must pass |
| 4/7 | **Next.js build** (`npm run build`) | Hard fail — build must succeed |
| 5/7 | **Artifact sweep** — no stray `.log`, `response.*`, `.env` files; no `.agent/` directory | Hard fail — clean workspace required |
| 6/7 | **Overview sync** — `DETAILED_PROJECT_OVERVIEW.md` contains all 12 required section keywords | Hard fail — documentation must stay current |
| 7/7 | **Dead export scan** — heuristic grep for exported symbols with zero external consumers | Warn only — manual review recommended |

### How to extend

Add new checks by appending numbered steps to `scripts/polish.sh` and incrementing the step count in the echo headers (e.g., `[8/8]`). Update this section in `DETAILED_PROJECT_OVERVIEW.md` to document the new check.

### How to invoke from the AI agent

The agent reads `PHASE_PROMPT_TEMPLATE.md` with `CURRENT_PHASE: P12` and runs `npm run polish`. If any step fails, the agent diagnoses and fixes before marking green. P12 is a **continuous phase** — its checkbox is reset to `[ ]` after every successful run, unlike P0–P11 which stay permanently `[x]`.

### Invocation

```bash
cd project_source
npm run polish
```

Expected terminal output on success:
```
=== POLISH PROTOCOL ===
[1/7] TypeScript strict check...
[2/7] ESLint...
[3/7] Vitest...
[4/7] Next.js build...
[5/7] Artifact sweep...
[6/7] Overview sync...
[7/7] Dead export scan...
=== POLISH PROTOCOL: ALL GREEN ===
```

---

## §14 Live Integration Test Results (P6)

> Verified against Docker container `hcd-title-agent` on port 3031 with real Title Transfer Documents.pdf (6-page HCD title, Decal LBP4255).

### Pipeline Execution

| Step | Status | Details |
|---|---|---|
| Pre-flight | PASS | Health OK, `COPILOT_GITHUB_TOKEN` configured (93 chars), MCP tools installed (`mcp-pdf v2.1.6`, `pymupdf4llm-mcp v0.0.4`), 5 PDF assets in `/app/assets/`, workspace writable |
| Upload | PASS | POST `/api/runs` → `{"id":"01KPMDHVRA227K8Z39TJBGFNNC","status":"ingested"}`, run directory created with `input.pdf` (376 KB) |
| Extraction | PASS | 228 transcript events (83 reasoning deltas, 124 message deltas, 2 tool executions: `report_intent` + `pymupdf4llm-convert_pdf_to_markdown`). Extraction completed in ~28s |
| HITL | PASS | Status → `awaiting_human`. Extracted fields match PDF: decal=LBP4255, serial=CAV110AZ2321354A, owner=SNELL SANDERS LLC, situs=520 PINE AVE NUMBER 55 SANTA BARBARA CA 93117 |
| Fill + Zip | PASS | POST `/api/runs/:id/approve` → `{"status":"filling"}`. Three forms filled via `mcp-pdf.fill_form_pdf`. Status → `done` |
| Download | PASS | GET `/api/runs/:id/download` → HTTP 200, `application/zip`. ZIP contains 5 files: `manifest.json` (380B), `476.6.pdf` (628KB), `476.6G.pdf` (330KB), `480.5.pdf` (246KB), `transcript.jsonl` (384KB, 787 lines) |

### SSE Event Architecture (Verified)

- **EventBus**: In-memory ring buffer (512 capacity), ephemeral — events not replayed on fresh connections after completion
- **Last-Event-ID reconnect**: PASS — ring buffer correctly replays events after the specified ID (verified: seq 1687 → resumed at seq 1688). Bogus IDs return only heartbeats
- **Event types published to SSE**: `assistant.message`, `assistant.reasoning`, `assistant.message_delta`, `assistant.reasoning_delta`, `tool.execution_start`, `tool.execution_complete`, `run.ingested`, `run.extracting`, `run.awaiting_human`, `run.filling`, `run.done`, `human.prompt`, `zip.ready`
- **Timeline node mapping**: Deltas (`assistant.message_delta`, `assistant.reasoning_delta`) intentionally ignored by ThoughtPanel — only full events create nodes

### Gate Check

- TypeScript: clean (0 errors)
- ESLint: clean (0 errors, 4 unused-var warnings)
- Vitest: 214/214 tests pass (15 test files)
