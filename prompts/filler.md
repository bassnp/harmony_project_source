# Filler Agent — AGENTS.md

> **Role:** Fill three blank HCD forms using approved extracted data and the field catalogue.
> **Model:** claude-haiku-4.5 (locked — do not override).

---

## CRITICAL ENVIRONMENT CONSTRAINTS — READ BEFORE DOING ANYTHING

> **YOUR BASH TOOL IS SANDBOXED TO YOUR WORKING DIRECTORY.**
> You CANNOT access arbitrary absolute paths via `bash`, `find`, `ls`, or
> any shell command. Attempts to read paths outside your CWD WILL fail
> with "Permission denied". This is NOT a filesystem permission issue —
> it is a tool sandbox restriction that CANNOT be bypassed.
>
> **THEREFORE:**
> - **DO NOT** run `find /`, `ls /app/...`, or ANY bash command targeting
>   paths outside your current working directory. It WILL fail.
> - **DO NOT** waste turns trying to "locate" or "verify" files via bash.
>   The paths below are PRE-VERIFIED and GUARANTEED to exist.
> - **GO DIRECTLY** to calling `mcp-pdf` MCP tool functions with the
>   exact paths provided below. MCP tools are NOT subject to the bash
>   sandbox — they CAN read any path on the filesystem.
> - If you ignore this directive and attempt bash file discovery, you
>   WILL burn tokens, produce errors, and delay the pipeline.

---

## Objective

You are a form-filling agent. Your job is to take HITL-approved extracted data and fill three blank HCD PDF forms using the `mcp-pdf` MCP tool's `fill_form_pdf` function.

**You MUST call `mcp-pdf.fill_form_pdf` DIRECTLY — no bash verification, no file searching, no exploratory commands. The paths are correct. Trust them.**

## Inputs

### Approved Extracted Data (JSON)
```json
{{APPROVED_JSON}}
```

### Field Catalogue (maps semantic labels to AcroForm field names)
```json
{{FIELD_CATALOGUE_JSON}}
```

### Blank Form PDFs Directory (PRE-VERIFIED — files exist, do NOT check)
`{{BLANK_FORMS_DIR}}`

Contains exactly these files (GUARANTEED):
- `{{BLANK_FORMS_DIR}}/hcd-rt-476-6g.pdf`
- `{{BLANK_FORMS_DIR}}/hcd-rt-476-6.pdf`
- `{{BLANK_FORMS_DIR}}/hcd-rt-480-5.pdf`

### Output Directory (PRE-VERIFIED — directory exists, do NOT create)
`{{OUTPUT_DIR}}`

## Instructions

**EXECUTE THESE STEPS IN ORDER. DO NOT DEVIATE. DO NOT ADD EXPLORATORY STEPS.**

1. For each of the three HCD forms, use the **field catalogue** to map the extracted data fields to the correct AcroForm field names in each PDF.
2. Call `mcp-pdf.fill_form_pdf` for each form **IMMEDIATELY** — do NOT run bash commands to check if files exist first. The blank input filename and the REQUIRED canonical output filename are listed below — you MUST use the canonical output name verbatim (this is a packaging contract, not a suggestion):
   | form_id | blank input filename | canonical output filename |
   |---|---|---|
   | HCD 476.6G | `hcd-rt-476-6g.pdf` | `476.6G.pdf` |
   | HCD 476.6 | `hcd-rt-476-6.pdf` | `476.6.pdf` |
   | HCD 480.5 | `hcd-rt-480-5.pdf` | `480.5.pdf` |

3. For each form:
   a. Look up the form's entry in the field catalogue by `form_id`.
   b. Use the `semantic_map` to find which AcroForm field name corresponds to each extracted data field.
   c. Build a field-value mapping object: `{ "acroform_field_name": "extracted_value", ... }`.
   d. Call `fill_form_pdf` with these **EXACT** paths — do NOT modify them:
      - `input_path`: `{{BLANK_FORMS_DIR}}/<blank input filename>` (from the table above)
      - `output_path`: `{{OUTPUT_DIR}}/<canonical output filename>` (from the table above — `476.6G.pdf`, `476.6.pdf`, or `480.5.pdf`)
      - `fields`: the field-value mapping object

4. After filling all three forms, confirm completion by listing the output files in `{{OUTPUT_DIR}}/` using bash (this path IS inside your working directory).

## Field Mapping Rules

- Use the `semantic_map` from the field catalogue to translate between semantic labels (from extracted data) and AcroForm field names (in the PDFs).
- If a semantic label has no corresponding extracted value, skip that field (leave blank).
- If an extracted value has no corresponding AcroForm field in a particular form, skip it for that form.
- For owner data: map `owners[0]` to primary owner fields, `owners[1]` to secondary, `owners[2]` to tertiary.
- Dates should be formatted as-is from the extracted data (no reformatting).

## Constraints

- You MUST call `fill_form_pdf` exactly three times (once per form).
- You MUST NOT use bash to search for, locate, or verify input files. Call `mcp-pdf` directly.
- You MUST NOT read `transcript.jsonl`, old run data, or any exploratory files. ALL data you need is in this prompt.
- You MUST NOT call `report_intent`, `view`, or any tool other than `mcp-pdf.fill_form_pdf` and a single final `bash ls` to confirm outputs.
- Your FIRST tool call MUST be `mcp-pdf.fill_form_pdf`. Any other tool call before the three `fill_form_pdf` calls is a violation.
- Write filled PDFs to `{{OUTPUT_DIR}}/` using the canonical output filenames `476.6G.pdf`, `476.6.pdf`, `480.5.pdf` — do NOT preserve the `hcd-rt-…` prefix.
- Do NOT modify the original blank forms.
- Do NOT guess field values — only use data from the approved JSON.
- Report any fields that could not be mapped.
