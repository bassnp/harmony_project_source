/**
 * smoke-extract — Gate Check script for Phase P4.
 *
 * Invokes `spawnCopilot()` with the extractor prompt against a sample PDF
 * and asserts:
 *   1. exitCode === 0
 *   2. parsed final JSON validates against ExtractedFieldsSchema
 *   3. at least one tool.execution_start to mcp-pdf or pymupdf4llm is recorded
 *
 * Usage: npx tsx scripts/smoke-extract.ts <path-to-input.pdf>
 */

import path from "node:path";
import { spawnCopilot } from "../src/lib/copilot/spawner";
import { buildExtractorPrompt } from "../src/lib/copilot/prompts";
import { ExtractedFieldsSchema } from "../src/lib/pdf/extractedSchema";
import { isCopilotEvent } from "../src/lib/copilot/stdoutParser";
import { ulid } from "ulid";

// ---------------------------------------------------------------------------
// CLI argument
// ---------------------------------------------------------------------------

const inputArg = process.argv[2];
if (!inputArg) {
  console.error("Usage: npx tsx scripts/smoke-extract.ts <path-to-input.pdf>");
  process.exit(1);
}

const inputPdfPath = path.resolve(inputArg);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runId = ulid();
  const runDir = `/workspace/runs/${runId}`;
  const promptText = buildExtractorPrompt(inputPdfPath);

  console.log(`[smoke-extract] Starting extraction run ${runId}`);
  console.log(`[smoke-extract] Input PDF: ${inputPdfPath}`);

  const result = await spawnCopilot({
    runId,
    promptText,
    cwd: runDir,
    timeoutMs: 300_000, // 5 minutes for smoke test
  });

  // --- Assertion 1: exitCode === 0 ----------------------------------------
  if (result.exitCode !== 0) {
    console.error(
      `[smoke-extract] FAIL: exitCode = ${result.exitCode} (expected 0)`,
    );
    console.error(
      `[smoke-extract] Transcript events: ${result.transcript.length}`,
    );
    console.error(
      `[smoke-extract] Final text: ${result.finalAssistantText.slice(0, 200)}`,
    );
    process.exit(1);
  }
  console.log("[smoke-extract] PASS: exitCode === 0");

  // --- Assertion 2: finalAssistantText validates as ExtractedFields --------
  let parsedFields: unknown;
  try {
    parsedFields = JSON.parse(result.finalAssistantText);
  } catch {
    // Try to extract JSON from within the text (in case of wrapping)
    const jsonMatch = result.finalAssistantText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsedFields = JSON.parse(jsonMatch[0]);
      } catch {
        console.error(
          "[smoke-extract] FAIL: finalAssistantText is not valid JSON",
        );
        console.error(
          `[smoke-extract] Text: ${result.finalAssistantText.slice(0, 500)}`,
        );
        process.exit(1);
      }
    } else {
      console.error(
        "[smoke-extract] FAIL: finalAssistantText contains no JSON object",
      );
      process.exit(1);
    }
  }

  const validation = ExtractedFieldsSchema.safeParse(parsedFields);
  if (!validation.success) {
    console.error(
      "[smoke-extract] FAIL: extracted JSON does not match ExtractedFieldsSchema",
    );
    console.error("[smoke-extract] Errors:", JSON.stringify(validation.error, null, 2));
    process.exit(1);
  }
  console.log("[smoke-extract] PASS: extracted JSON validates against schema");
  console.log(
    `[smoke-extract] Fields: decal=${validation.data.decal_number}, serial=${validation.data.serial_number}, owners=${validation.data.owners.length}`,
  );

  // --- Assertion 3: at least one tool.execution_start to MCP tools ----------
  const toolCalls = result.transcript.filter(
    (e) =>
      isCopilotEvent(e) &&
      e.type === "tool.execution_start" &&
      e.data &&
      typeof e.data === "object" &&
      "toolName" in e.data &&
      typeof (e.data as Record<string, unknown>).toolName === "string" &&
      /(mcp-pdf|pymupdf4llm|extract_text|convert_pdf|extract_form_data)/.test(
        (e.data as Record<string, unknown>).toolName as string,
      ),
  );

  if (toolCalls.length === 0) {
    console.error(
      "[smoke-extract] FAIL: no tool.execution_start events to mcp-pdf or pymupdf4llm found",
    );
    console.error(
      `[smoke-extract] Total events: ${result.transcript.length}`,
    );
    const allToolCalls = result.transcript.filter(
      (e) => isCopilotEvent(e) && e.type === "tool.execution_start",
    );
    console.error(
      `[smoke-extract] All tool.execution_start events: ${JSON.stringify(allToolCalls.map((e) => isCopilotEvent(e) ? (e.data as Record<string, unknown>).toolName : e))}`,
    );
    process.exit(1);
  }
  console.log(
    `[smoke-extract] PASS: ${toolCalls.length} MCP tool call(s) recorded`,
  );

  // --- All passed ----------------------------------------------------------
  console.log("[smoke-extract] ALL ASSERTIONS PASSED");
}

main().catch((err) => {
  console.error("[smoke-extract] Unexpected error:", err);
  process.exit(1);
});
