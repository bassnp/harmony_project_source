/**
 * prompts — Builders for Copilot CLI prompt text (extractor + filler).
 *
 * Each builder reads the corresponding static markdown prompt from
 * `prompts/` and injects dynamic context (file paths, field catalogue,
 * approved data). The result is passed as `-p` argument to `copilot`.
 *
 * Ref: references/research/COPILOT_CLI_HIGH_QUALITY_REFERENCE.md §2.1
 */

import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Prompt template paths
// ---------------------------------------------------------------------------

const PROMPTS_DIR = path.resolve(process.cwd(), "prompts");

/**
 * Build the extractor prompt for a given input PDF.
 *
 * @param inputPdfPath Absolute path to the uploaded title PDF.
 * @returns Full prompt text for the Copilot extractor stage.
 */
export function buildExtractorPrompt(inputPdfPath: string): string {
  const template = readFileSync(
    path.join(PROMPTS_DIR, "extractor.md"),
    "utf-8",
  );
  return template.replace("{{INPUT_PDF_PATH}}", inputPdfPath);
}

/**
 * Build the filler prompt for a given set of approved fields.
 *
 * @param approvedJson Stringified JSON of the HITL-approved extracted fields.
 * @param fieldCatalogueJson Stringified JSON of the field catalogue.
 * @param outputDir Absolute path to the directory for filled PDFs.
 * @param blankFormsDir Absolute path to the directory containing blank HCD forms.
 * @returns Full prompt text for the Copilot filler stage.
 */
export function buildFillerPrompt(
  approvedJson: string,
  fieldCatalogueJson: string,
  outputDir: string,
  blankFormsDir: string,
): string {
  const template = readFileSync(
    path.join(PROMPTS_DIR, "filler.md"),
    "utf-8",
  );
  return template
    .replace("{{APPROVED_JSON}}", approvedJson)
    .replace("{{FIELD_CATALOGUE_JSON}}", fieldCatalogueJson)
    .replace("{{OUTPUT_DIR}}", outputDir)
    .replace("{{BLANK_FORMS_DIR}}", blankFormsDir);
}
