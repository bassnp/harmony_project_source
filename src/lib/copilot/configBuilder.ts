/**
 * configBuilder — Materializes per-run Copilot CLI MCP configuration.
 *
 * Writes a `mcp-config.json` file to a unique per-run directory so that
 * concurrent runs never share Copilot state. The config file uses the
 * Copilot CLI format (`mcpServers` top-level key, `type: "stdio"`).
 *
 * Ref: references/research/COPILOT_MCP_CONFIG_HIGH_QUALITY_REFERENCE.md §"GitHub Copilot CLI MCP Configuration Format"
 * Ref: references/research/MCP_PDF_SERVERS_HIGH_QUALITY_REFERENCE.md §"mcp-pdf"
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Pattern for valid run IDs: alphanumeric, hyphens, underscores (1-128 chars). */
const VALID_RUN_ID = /^[0-9A-Za-z_-]{1,128}$/;

/**
 * Validate that a runId is safe for use as a directory name.
 * Prevents path traversal attacks (e.g. `../../etc`).
 */
function assertSafeRunId(runId: string): void {
  if (!runId || !VALID_RUN_ID.test(runId)) {
    throw new Error(
      `Invalid runId "${runId}": must be 1-128 alphanumeric/hyphen/underscore characters.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a single MCP server entry in the Copilot CLI config. */
export interface McpServerEntry {
  type: "stdio" | "http";
  command: string;
  args: string[];
  env?: Record<string, string>;
  tools?: string[];
}

/** The top-level Copilot CLI MCP config file structure. */
export interface CopilotMcpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/** Options for building the MCP config. */
export interface ConfigBuilderOptions {
  /** Unique run identifier (ULID). */
  runId: string;
  /** Base directory for per-run agent state. Defaults to `/workspace/agents`. */
  baseDir?: string;
}

// ---------------------------------------------------------------------------
// Default MCP server definitions
// ---------------------------------------------------------------------------

/**
 * Standard MCP servers for the HCD Title Transfer pipeline.
 * - mcp-pdf: OCR + form read + form fill + document assembly
 * - pymupdf4llm: High-fidelity PDF→Markdown for LLM context
 */
const DEFAULT_MCP_SERVERS: Record<string, McpServerEntry> = {
  "mcp-pdf": {
    type: "stdio",
    command: "uvx",
    args: ["mcp-pdf[forms]"],
  },
  pymupdf4llm: {
    type: "stdio",
    command: "uvx",
    args: ["pymupdf4llm-mcp@latest", "stdio"],
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build and persist a Copilot CLI MCP config for a specific run.
 *
 * Creates the directory `<baseDir>/<runId>/.copilot/` and writes
 * `mcp-config.json` into it. Returns the absolute path to the
 * `.copilot` directory (pass as `--config-dir` to `copilot` CLI).
 *
 * @returns Absolute path to the per-run `.copilot` directory.
 */
export async function buildRunConfig(
  options: ConfigBuilderOptions,
): Promise<string> {
  assertSafeRunId(options.runId);

  const baseDir = options.baseDir ?? "/workspace/agents";
  const copilotDir = path.join(baseDir, options.runId, ".copilot");

  await mkdir(copilotDir, { recursive: true });

  const config: CopilotMcpConfig = {
    mcpServers: { ...DEFAULT_MCP_SERVERS },
  };

  const configPath = path.join(copilotDir, "mcp-config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  return copilotDir;
}

/**
 * Generate the MCP config object without persisting to disk.
 * Useful for testing or introspection.
 */
export function buildMcpConfig(): CopilotMcpConfig {
  return {
    mcpServers: { ...DEFAULT_MCP_SERVERS },
  };
}
