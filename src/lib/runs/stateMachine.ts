/**
 * stateMachine — Deterministic run lifecycle with event publishing.
 *
 * State flow: ingested → extracting → awaiting_human → filling → zipping → done
 * Any state can transition to `failed` on error.
 *
 * Each transition:
 *   1. Validates the transition is legal.
 *   2. Persists the new status to SQLite.
 *   3. Publishes a `run.<status>` event on the EventBus.
 *
 * The orchestrator (`advanceRun`) drives the async pipeline end-to-end,
 * including spawning Copilot for extraction and filling.
 *
 * Ref: references/research/ORCHESTRATION_HIGH_QUALITY_REFERENCE.md §4, §5
 */

import { mkdir } from "node:fs/promises";
import { readFileSync, readdirSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { getEventBus } from "@/lib/eventbus";
import {
  getRun,
  updateRun,
  type RunRow,
  type RunStatus,
} from "@/lib/runs/store";
import { spawnCopilot, type SpawnCopilotResult } from "@/lib/copilot/spawner";
import {
  buildExtractorPrompt,
  buildFillerPrompt,
} from "@/lib/copilot/prompts";
import { ExtractedFieldsSchema } from "@/lib/pdf/extractedSchema";
import { loadFieldCatalogue } from "@/lib/pdf/fieldCatalogue";
import { createZipPacket } from "@/lib/pdf/zipper";

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a JSON object from LLM output text.
 *
 * LLMs often wrap JSON in markdown fences or include prose around it.
 * This function tries, in order:
 *   1. Direct `JSON.parse()` (pure JSON response).
 *   2. Extract from markdown code fences (```json ... ``` or ``` ... ```).
 *   3. Find the first `{ ... }` substring that parses as valid JSON.
 *
 * @internal Exported for unit testing; not part of the public API.
 */
export function extractJsonFromText(text: string): unknown {
  // Attempt 1: direct parse
  try {
    return JSON.parse(text);
  } catch {
    // continue to fallback strategies
  }

  // Attempt 2: markdown code fences
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // continue
    }
  }

  // Attempt 3: find the first balanced { ... } substring
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // all strategies exhausted
    }
  }

  throw new SyntaxError("No valid JSON object found in LLM output");
}

/**
 * Resolve extracted JSON from a Copilot spawn result using multiple
 * fallback strategies. LLMs are non-deterministic — the model may:
 *   1. Return JSON directly in the final assistant message.
 *   2. Write JSON to `output.json` on disk via a tool call.
 *   3. Embed JSON in a tool execution result.
 *
 * Returns the parsed object if any strategy succeeds, or `null` if
 * all strategies are exhausted.
 *
 * @internal Exported for unit testing; not part of the public API.
 */
export function resolveExtractedJson(
  result: SpawnCopilotResult,
  outDir: string,
): unknown | null {
  // Strategy 1: Parse from the final assistant message text
  if (result.finalAssistantText) {
    try {
      return extractJsonFromText(result.finalAssistantText);
    } catch {
      // fall through to next strategy
    }
  }

  // Strategy 2: Read output.json from disk (model wrote it via bash/tool)
  const outputJsonPath = path.join(outDir, "output.json");
  if (existsSync(outputJsonPath)) {
    try {
      const diskContent = readFileSync(outputJsonPath, "utf-8");
      return JSON.parse(diskContent);
    } catch {
      // fall through to next strategy
    }
  }

  // Strategy 3: Search tool execution results for valid JSON
  for (const resultText of result.toolResultTexts) {
    try {
      return extractJsonFromText(resultText);
    } catch {
      // try next tool result
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/** Legal transitions: `from → Set<to>`. */
const TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  ingested: new Set(["extracting", "failed"]),
  extracting: new Set(["awaiting_human", "failed"]),
  awaiting_human: new Set(["filling", "failed"]),
  filling: new Set(["zipping", "failed"]),
  zipping: new Set(["done", "failed"]),
  done: new Set(), // terminal
  failed: new Set(), // terminal
};

/**
 * Attempt a state transition. Throws if the transition is illegal.
 * Persists to SQLite and publishes a `run.<newStatus>` event.
 */
export function transition(
  runId: string,
  from: RunStatus,
  to: RunStatus,
  extra?: Partial<Pick<RunRow, "extracted_json" | "approved_json" | "zip_path" | "error">>,
): void {
  const allowed = TRANSITIONS[from];
  if (!allowed.has(to)) {
    throw new Error(
      `Illegal transition: ${from} → ${to} for run ${runId}`,
    );
  }

  updateRun(runId, { status: to, ...extra });

  const bus = getEventBus();
  bus.publish({
    channel: "run",
    type: `run.${to}`,
    runId,
    payload: extra ?? {},
  });
}

/**
 * Transition a run to `failed` with an error message.
 * Safe to call from any non-terminal state.
 */
export function failRun(runId: string, currentStatus: RunStatus, error: string): void {
  if (currentStatus === "done" || currentStatus === "failed") return;
  transition(runId, currentStatus, "failed", { error });
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/** Base directory for all run artifacts inside the container volume. */
const WORKSPACE_RUNS_DIR = "/workspace/runs";

/** Resolve the per-run workspace directory. */
export function runDir(runId: string): string {
  return path.join(WORKSPACE_RUNS_DIR, runId);
}

/** Ensure the per-run directory structure exists. */
async function ensureRunDirs(runId: string): Promise<{
  root: string;
  outDir: string;
}> {
  const root = runDir(runId);
  const outDir = path.join(root, "out");
  await mkdir(outDir, { recursive: true });
  return { root, outDir };
}

// ---------------------------------------------------------------------------
// Orchestrator — drives the async pipeline
// ---------------------------------------------------------------------------

/** Path to the blank HCD forms directory (mounted in container). */
const BLANK_FORMS_DIR = path.resolve(process.cwd(), "assets");

/**
 * Advance a run through the full pipeline (fire-and-forget from POST /api/runs).
 *
 * Flow: ingested → extracting → awaiting_human (pause for HITL).
 * After approval: filling → zipping → done.
 *
 * This function handles ingested → extract → HITL pause.
 * The approve route calls `resumeAfterApproval()` to continue.
 */
export async function advanceRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== "ingested") return;

  const { root } = await ensureRunDirs(runId);

  // --- Transition: ingested → extracting ------------------------------------
  transition(runId, "ingested", "extracting");

  try {
    const inputPdfPath = path.join(root, "input.pdf");
    const prompt = buildExtractorPrompt(inputPdfPath);

    const result = await spawnCopilot({
      runId,
      promptText: prompt,
      cwd: root,
    });

    if (result.exitCode !== 0) {
      failRun(runId, "extracting", `Copilot exited with code ${result.exitCode}`);
      return;
    }

    // Parse the extraction output as JSON and validate against schema.
    // The model may return JSON in its final message, write it to disk,
    // or embed it in a tool call result — we try all three strategies.
    const parsed = resolveExtractedJson(result, path.join(root, "out"));
    if (!parsed) {
      failRun(
        runId,
        "extracting",
        `Failed to parse extraction output as JSON: ${result.finalAssistantText.slice(0, 500)}`,
      );
      return;
    }
    const validated = ExtractedFieldsSchema.safeParse(parsed);
    if (!validated.success) {
      failRun(
        runId,
        "extracting",
        `Extraction output failed schema validation: ${JSON.stringify(validated.error.issues)}`,
      );
      return;
    }
    const extractedJson = JSON.stringify(validated.data);

    // --- Transition: extracting → awaiting_human ----------------------------
    transition(runId, "extracting", "awaiting_human", {
      extracted_json: extractedJson,
    });

    // Publish HITL prompt event for the UI
    const bus = getEventBus();
    bus.publish({
      channel: "run",
      type: "human.prompt",
      runId,
      payload: { fields: JSON.parse(extractedJson) },
    });
  } catch (err) {
    failRun(
      runId,
      "extracting",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Resume the pipeline after HITL approval.
 *
 * Flow: awaiting_human → filling → zipping → done.
 */
export async function resumeAfterApproval(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== "filling") return; // Transition already done by approve route

  const { root, outDir } = await ensureRunDirs(runId);

  try {
    // Build filler prompt with approved data and field catalogue
    const approvedJson = run.approved_json ?? "{}";
    const catalogue = loadFieldCatalogue();
    const fieldCatalogueJson = JSON.stringify(catalogue);

    const prompt = buildFillerPrompt(
      approvedJson,
      fieldCatalogueJson,
      outDir,
      BLANK_FORMS_DIR,
    );

    const result = await spawnCopilot({
      runId,
      promptText: prompt,
      cwd: root,
    });

    if (result.exitCode !== 0) {
      failRun(runId, "filling", `Copilot filler exited with code ${result.exitCode}`);
      return;
    }

    // --- Post-fill validation: enforce the 3 canonical output filenames -----
    // The filler prompt instructs Copilot to write `476.6G.pdf`, `476.6.pdf`,
    // and `480.5.pdf`. As a safety net, also accept the original blank-form
    // filenames (`hcd-rt-476-6g.pdf` etc.) and rename them in-place.
    const RENAME_MAP: Record<string, string> = {
      "hcd-rt-476-6g.pdf": "476.6G.pdf",
      "hcd-rt-476-6.pdf": "476.6.pdf",
      "hcd-rt-480-5.pdf": "480.5.pdf",
    };
    const REQUIRED_OUTPUTS = ["476.6G.pdf", "476.6.pdf", "480.5.pdf"] as const;
    try {
      const rawFiles = readdirSync(outDir).filter((f) => f.toLowerCase().endsWith(".pdf"));
      // Build a case-insensitive lookup: lowered name → actual filesystem name
      const fsMap = new Map<string, string>();
      for (const f of rawFiles) fsMap.set(f.toLowerCase(), f);

      const present = new Set(rawFiles);
      for (const [orig, canon] of Object.entries(RENAME_MAP)) {
        // Match case-insensitively against actual filesystem entries
        const actual = fsMap.get(orig.toLowerCase());
        if (actual && !present.has(canon)) {
          renameSync(path.join(outDir, actual), path.join(outDir, canon));
          present.delete(actual);
          present.add(canon);
          fsMap.delete(orig.toLowerCase());
          fsMap.set(canon.toLowerCase(), canon);
        }
      }
      const missing = REQUIRED_OUTPUTS.filter((n) => !existsSync(path.join(outDir, n)));
      if (missing.length > 0) {
        failRun(
          runId,
          "filling",
          `Filler did not produce required outputs: missing ${missing.join(", ")}. Found: [${[...present].join(", ")}]`,
        );
        return;
      }
    } catch (err) {
      failRun(
        runId,
        "filling",
        `Post-fill validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // --- Transition: filling → zipping --------------------------------------
    transition(runId, "filling", "zipping");

    try {
      // Read transcript for inclusion in the ZIP
      const transcriptPath = path.join(root, "transcript.jsonl");
      let transcriptContent: string | undefined;
      try {
        transcriptContent = readFileSync(transcriptPath, "utf-8");
      } catch {
        transcriptContent = undefined;
      }

      const zipPath = await createZipPacket({
        runId,
        outDir,
        transcriptPath: transcriptContent ? transcriptPath : undefined,
        outputZipPath: path.join(root, "packet.zip"),
      });

      // --- Transition: zipping → done ---------------------------------------
      transition(runId, "zipping", "done", { zip_path: zipPath });

      const bus = getEventBus();
      bus.publish({
        channel: "run",
        type: "zip.ready",
        runId,
        payload: { zipPath },
      });
    } catch (err) {
      failRun(
        runId,
        "zipping",
        err instanceof Error ? err.message : String(err),
      );
    }
  } catch (err) {
    const currentRun = getRun(runId);
    const status = currentRun?.status ?? "filling";
    failRun(
      runId,
      status as RunStatus,
      err instanceof Error ? err.message : String(err),
    );
  }
}
