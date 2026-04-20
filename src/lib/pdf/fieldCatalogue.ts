/**
 * fieldCatalogue — Typed loader for `prompts/field_catalogue.json`.
 *
 * Provides read-only access to the discovered AcroForm field names
 * for each HCD blank form. The filler stage uses these names to map
 * extracted title data → form field writes.
 *
 * Ref: references/research/MCP_PDF_SERVERS_HIGH_QUALITY_REFERENCE.md §"mcp-pdf"
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Zod schemas — runtime validation for catalogue JSON
// ---------------------------------------------------------------------------

const CatalogueFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string(),
  page: z.number().int().min(0),
  rect: z.array(z.number()).nullable(),
  value: z.string().nullable(),
  semantic_label: z.string().nullable(),
});

const CatalogueFormSchema = z.object({
  form_id: z.string().min(1),
  filename: z.string().min(1),
  fields: z.array(CatalogueFieldSchema),
});

const FieldCatalogueSchema = z.object({
  version: z.string(),
  generated_at: z.string(),
  mode: z.string(),
  forms: z.array(CatalogueFormSchema).min(1),
  semantic_map: z.record(z.string(), z.record(z.string(), z.string())),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single AcroForm field discovered from a PDF. */
export interface CatalogueField {
  name: string;
  type: string;
  page: number;
  rect: number[] | null;
  value: string | null;
  semantic_label: string | null;
}

/** One form entry in the catalogue. */
export interface CatalogueForm {
  form_id: string;
  filename: string;
  fields: CatalogueField[];
}

/** Top-level field catalogue structure. */
export interface FieldCatalogue {
  version: string;
  generated_at: string;
  mode: string;
  forms: CatalogueForm[];
  semantic_map: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Singleton loader
// ---------------------------------------------------------------------------

let _cached: FieldCatalogue | null = null;

/**
 * Load the field catalogue from disk (cached after first read).
 *
 * @param cataloguePath Override path for testing. Defaults to `prompts/field_catalogue.json`
 *   relative to the app root (`/app` in container, or `process.cwd()` locally).
 */
export function loadFieldCatalogue(cataloguePath?: string): FieldCatalogue {
  if (_cached) return _cached;

  const resolved = cataloguePath
    ?? path.resolve(process.cwd(), "prompts", "field_catalogue.json");

  const raw = readFileSync(resolved, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse field catalogue JSON at ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = FieldCatalogueSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid field catalogue structure at ${resolved}: ${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }

  _cached = result.data;
  return _cached;
}

/**
 * Get the catalogue entry for a specific form.
 *
 * @param formId One of `HCD_476_6G`, `HCD_476_6`, `HCD_480_5`.
 * @throws If the form is not found in the catalogue.
 */
export function getFormFields(formId: string): CatalogueForm {
  const catalogue = loadFieldCatalogue();
  const form = catalogue.forms.find((f) => f.form_id === formId);
  if (!form) {
    throw new Error(
      `Form "${formId}" not found in field catalogue. Available: ${catalogue.forms.map((f) => f.form_id).join(", ")}`,
    );
  }
  return form;
}

/**
 * Get the semantic-label-to-field-name mapping for a specific form.
 * Returns a map of `{ semantic_label: field_name }` for fields that have labels.
 */
export function getSemanticMap(formId: string): Map<string, string> {
  const form = getFormFields(formId);
  const map = new Map<string, string>();

  for (const field of form.fields) {
    if (field.semantic_label) {
      map.set(field.semantic_label, field.name);
    }
  }

  return map;
}

/** Reset the cached catalogue (for testing). */
export function _resetCache(): void {
  _cached = null;
}
