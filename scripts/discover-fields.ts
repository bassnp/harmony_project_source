/**
 * discover-fields.ts — One-shot script to discover AcroForm fields from blank HCD PDFs.
 *
 * Usage:
 *   npx tsx scripts/discover-fields.ts [--direct]
 *
 * Modes:
 *   Default:  Spawns Copilot CLI with MCP tools to discover fields via `extract_form_data`.
 *   --direct: Bypasses Copilot CLI; calls Python/PyMuPDF directly for reliable extraction.
 *
 * Output:
 *   Writes prompts/field_catalogue.json with structure:
 *   { forms: [{ form_id, filename, fields: [{ name, type, page, rect }] }] }
 *
 * Ref: references/research/MCP_PDF_SERVERS_HIGH_QUALITY_REFERENCE.md §"mcp-pdf"
 * Ref: references/research/COPILOT_MCP_CONFIG_HIGH_QUALITY_REFERENCE.md
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** HCD form definitions — the PDFs we need to catalog. */
const HCD_FORMS = [
  { form_id: "HCD_476_6G", filename: "hcd-rt-476-6g.pdf" },
  { form_id: "HCD_476_6", filename: "hcd-rt-476-6.pdf" },
  { form_id: "HCD_480_5", filename: "hcd-rt-480-5.pdf" },
] as const;

/** Resolve path to assets directory (inside container: /app/assets). */
const ASSETS_DIR = path.resolve(__dirname, "..", "assets");

/** Output path for the field catalogue. */
const OUTPUT_DIR = path.resolve(__dirname, "..", "prompts");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "field_catalogue.json");

/** Timeout for Copilot CLI spawn (ms). */
const COPILOT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FormField {
  name: string;
  type: string;
  page: number;
  rect: number[] | null;
  value: string | null;
  semantic_label?: string;
}

interface FormEntry {
  form_id: string;
  filename: string;
  fields: FormField[];
}

interface FieldCatalogue {
  version: string;
  generated_at: string;
  mode: "copilot" | "direct";
  forms: FormEntry[];
  semantic_map: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the semantic_map from discovered form entries.
 * Maps { form_id: { field_name: semantic_label } } for fields that have labels.
 */
function buildSemanticMap(forms: FormEntry[]): Record<string, Record<string, string>> {
  const map: Record<string, Record<string, string>> = {};
  for (const form of forms) {
    const formMap: Record<string, string> = {};
    for (const field of form.fields) {
      if (field.semantic_label) {
        formMap[field.name] = field.semantic_label;
      }
    }
    map[form.form_id] = formMap;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Direct mode: calls Python script for PyMuPDF field extraction
// ---------------------------------------------------------------------------

function discoverDirect(): FieldCatalogue {
  const forms: FormEntry[] = [];

  for (const form of HCD_FORMS) {
    const pdfPath = path.join(ASSETS_DIR, form.filename);
    if (!existsSync(pdfPath)) {
      console.error(`[WARN] PDF not found: ${pdfPath}`);
      forms.push({ form_id: form.form_id, filename: form.filename, fields: [] });
      continue;
    }

    const scriptPath = path.resolve(__dirname, "extract_form_fields.py");
    // Use the mcp-pdf uv tool's Python which has PyMuPDF (fitz) installed.
    // Falls back to system python3 if the uv tool path doesn't exist.
    const pythonPaths = [
      "/home/app/.local/share/uv/tools/mcp-pdf/bin/python3",
      "python3",
    ];
    let result = "";
    for (const pythonBin of pythonPaths) {
      try {
        result = execSync(`"${pythonBin}" "${scriptPath}" "${pdfPath}"`, {
          encoding: "utf-8",
          timeout: 30_000,
        });
        break;
      } catch (err) {
        if (pythonBin === pythonPaths[pythonPaths.length - 1]) throw err;
        // Try next Python
      }
    }

    const parsed = JSON.parse(result.trim()) as FormField[];
    forms.push({
      form_id: form.form_id,
      filename: form.filename,
      fields: parsed,
    });

    console.error(`[OK] ${form.form_id}: ${parsed.length} fields discovered`);
  }

  return {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    mode: "direct",
    forms,
    semantic_map: buildSemanticMap(forms),
  };
}

// ---------------------------------------------------------------------------
// Copilot mode: spawns Copilot CLI with MCP config
// ---------------------------------------------------------------------------

/** Build an inline MCP config file for the discovery run (self-contained). */
async function materializeDiscoveryConfig(): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");

  const configDir = path.join("/tmp", "agents", `discovery-${Date.now()}`, ".copilot");
  await mkdir(configDir, { recursive: true });

  const config = {
    mcpServers: {
      "mcp-pdf": {
        type: "stdio",
        command: "uvx",
        args: ["mcp-pdf[forms]"],
        tools: [""],
      },
      pymupdf4llm: {
        type: "stdio",
        command: "uvx",
        args: ["pymupdf4llm-mcp@latest", "stdio"],
        tools: [""],
      },
    },
  };

  await writeFile(path.join(configDir, "mcp-config.json"), JSON.stringify(config, null, 2), "utf-8");
  return configDir;
}

async function discoverViaCopilot(): Promise<FieldCatalogue> {
  const configDir = await materializeDiscoveryConfig();

  const pdfPaths = HCD_FORMS.map((f) => path.join(ASSETS_DIR, f.filename));
  const prompt = [
    "You have access to the mcp-pdf tool. For each of the following PDF files,",
    "call extract_form_data to get all AcroForm field names, types, pages, and rects.",
    "Return ONLY a JSON array of objects with structure:",
    '  [{ "form_id": "...", "filename": "...", "fields": [{ "name": "...", "type": "...", "page": N, "rect": [...], "value": "..." }] }]',
    "",
    "PDF files:",
    ...pdfPaths.map((p) => `  - ${p}`),
    "",
    "Return ONLY valid JSON. No markdown, no explanation.",
  ].join("\n");

  return new Promise<FieldCatalogue>((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--model=claude-haiku-4.5",
      "--output-format=json",
      "--no-ask-user",
      "--allow-all-tools",
      "--config-dir",
      configDir,
    ];

    const child = spawn("copilot", args, {
      env: { ...process.env, COPILOT_HOME: configDir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
      reject(new Error(`Copilot CLI timed out after ${COPILOT_TIMEOUT_MS}ms`));
    }, COPILOT_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`Copilot exited with code ${code}: ${stderr}`));
        return;
      }

      // Parse JSONL output — find the final assistant message with our data
      try {
        const lines = stdout.trim().split("\n");
        let formsData: FormEntry[] | null = null;

        for (const line of lines.reverse()) {
          try {
            const event = JSON.parse(line);
            if (event.type === "assistant.message" && event.content) {
              // Try to extract JSON from the content
              const jsonMatch = event.content.match(/\[[\s\S]*\]/);
              if (jsonMatch) {
                formsData = JSON.parse(jsonMatch[0]) as FormEntry[];
                break;
              }
            }
          } catch {
            // Skip non-JSON lines
          }
        }

        if (!formsData) {
          // Try parsing entire stdout as JSON
          const jsonMatch = stdout.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            formsData = JSON.parse(jsonMatch[0]) as FormEntry[];
          }
        }

        if (!formsData || formsData.length === 0) {
          reject(new Error("Could not parse form data from Copilot output"));
          return;
        }

        resolve({
          version: "1.0.0",
          generated_at: new Date().toISOString(),
          mode: "copilot",
          forms: formsData,
          semantic_map: buildSemanticMap(formsData),
        });
      } catch (err) {
        reject(new Error(`Failed to parse Copilot output: ${err}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const useDirectMode = process.argv.includes("--direct");
  console.error(`[discover-fields] Mode: ${useDirectMode ? "direct" : "copilot"}`);

  let catalogue: FieldCatalogue;

  if (useDirectMode) {
    catalogue = discoverDirect();
  } else {
    try {
      catalogue = await discoverViaCopilot();
    } catch (err) {
      console.error(`[WARN] Copilot mode failed: ${err}. Falling back to direct mode.`);
      catalogue = discoverDirect();
    }
  }

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(catalogue, null, 2), "utf-8");
  console.error(`[discover-fields] Written to ${OUTPUT_PATH}`);
  console.log(JSON.stringify(catalogue, null, 2));
}

main().catch((err) => {
  console.error(`[FATAL] ${err}`);
  process.exit(1);
});
