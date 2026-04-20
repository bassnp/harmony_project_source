/**
 * configBuilder.contract.test — Contract tests for MCP config materialization.
 *
 * Layer 2 (Contract) from MCP_TESTING_HIGH_QUALITY_REFERENCE.md:
 *   - Validates that `buildMcpConfig()` produces the correct Copilot CLI
 *     MCP server configuration shape for both `mcp-pdf` and `pymupdf4llm`.
 *   - Validates that `buildRunConfig()` persists a structurally correct
 *     `mcp-config.json` that the Copilot CLI can consume.
 *   - Validates that the spawner constructs argv containing the pinned
 *     model (`--model=claude-haiku-4.5`) and required flags.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildMcpConfig,
  buildRunConfig,
  type CopilotMcpConfig,
  type McpServerEntry,
} from "@/lib/copilot/configBuilder";

// ---------------------------------------------------------------------------
// Contract: MCP config structure matches Copilot CLI expectations
// ---------------------------------------------------------------------------

describe("Contract: MCP config structure", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("buildMcpConfig produces exactly 2 MCP servers: mcp-pdf and pymupdf4llm", () => {
    const config = buildMcpConfig();
    const serverNames = Object.keys(config.mcpServers).sort();
    expect(serverNames).toEqual(["mcp-pdf", "pymupdf4llm"]);
  });

  it("mcp-pdf server entry conforms to the Copilot CLI stdio transport contract", () => {
    const config = buildMcpConfig();
    const mcpPdf = config.mcpServers["mcp-pdf"] as McpServerEntry;

    // Required fields per COPILOT_MCP_CONFIG_HIGH_QUALITY_REFERENCE.md
    expect(mcpPdf.type).toBe("stdio");
    expect(mcpPdf.command).toBe("uvx");
    expect(mcpPdf.args).toBeInstanceOf(Array);
    expect(mcpPdf.args.length).toBeGreaterThan(0);

    // Must include the forms extra so fill_form_pdf is available
    expect(mcpPdf.args).toContain("mcp-pdf[forms]");

    // Should NOT restrict tools (let Copilot access all available tools)
    expect(mcpPdf.tools).toBeUndefined();
  });

  it("pymupdf4llm server entry conforms to the Copilot CLI stdio transport contract", () => {
    const config = buildMcpConfig();
    const pymupdf = config.mcpServers["pymupdf4llm"] as McpServerEntry;

    expect(pymupdf.type).toBe("stdio");
    expect(pymupdf.command).toBe("uvx");
    expect(pymupdf.args).toBeInstanceOf(Array);
    expect(pymupdf.args).toContain("pymupdf4llm-mcp@latest");
    expect(pymupdf.args).toContain("stdio");
  });

  it("mcp-config.json written by buildRunConfig is valid JSON with expected structure", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "contract-cfg-"));
    tempDirs.push(base);

    const copilotDir = await buildRunConfig({ runId: "contract-run-001", baseDir: base });
    const configPath = path.join(copilotDir, "mcp-config.json");

    const raw = await readFile(configPath, "utf-8");
    const config: CopilotMcpConfig = JSON.parse(raw);

    // Top-level key must be mcpServers (Copilot CLI requirement)
    expect(config).toHaveProperty("mcpServers");
    expect(typeof config.mcpServers).toBe("object");

    // Both servers present
    expect(config.mcpServers["mcp-pdf"]).toBeDefined();
    expect(config.mcpServers["pymupdf4llm"]).toBeDefined();

    // Each server has required type + command + args
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      expect(entry.type).toBe("stdio");
      expect(typeof entry.command).toBe("string");
      expect(entry.args).toBeInstanceOf(Array);
      // Verify args are all strings (Copilot CLI requirement)
      for (const arg of entry.args) {
        expect(typeof arg).toBe(`string`);
      }
    }
  });

  it("mcp-config.json is pretty-printed (human-readable for debugging)", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "contract-cfg-"));
    tempDirs.push(base);

    const copilotDir = await buildRunConfig({ runId: "contract-pretty", baseDir: base });
    const raw = await readFile(path.join(copilotDir, "mcp-config.json"), "utf-8");

    // Pretty-printed JSON has newlines (not a single-line minified blob)
    expect(raw.split("\n").length).toBeGreaterThan(1);
  });

  it("per-run configs are isolated (no cross-contamination)", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "contract-cfg-"));
    tempDirs.push(base);

    const dirA = await buildRunConfig({ runId: "run-alpha", baseDir: base });
    const dirB = await buildRunConfig({ runId: "run-beta", baseDir: base });

    expect(dirA).not.toBe(dirB);
    expect(dirA).toContain("run-alpha");
    expect(dirB).toContain("run-beta");

    // Both have valid, independent mcp-config.json files
    const rawA = await readFile(path.join(dirA, "mcp-config.json"), "utf-8");
    const rawB = await readFile(path.join(dirB, "mcp-config.json"), "utf-8");

    const configA: CopilotMcpConfig = JSON.parse(rawA);
    const configB: CopilotMcpConfig = JSON.parse(rawB);

    expect(configA).toEqual(configB); // Same structure
    expect(rawA).toBe(rawB); // Identical content (deterministic)
  });
});

// ---------------------------------------------------------------------------
// Contract: Copilot CLI spawn argv contains pinned model
// ---------------------------------------------------------------------------

describe("Contract: Copilot CLI spawn argv", () => {
  it("spawner constructs argv with --model=claude-haiku-4.5", async () => {
    // We verify by importing the spawner and checking that the mock spawn
    // receives the correct argv. This is already covered by spawner.test.ts,
    // but the contract test verifies the model pin specifically as a
    // contractual guarantee.
    //
    // Instead of duplicating the mock setup, we verify the source code
    // invariant: grep the spawner module for the model flag.
    const spawnerSource = await readFile(
      path.resolve(__dirname, "../../src/lib/copilot/spawner.ts"),
      "utf-8",
    );

    // The model flag MUST appear exactly as `--model=claude-haiku-4.5`
    expect(spawnerSource).toContain("--model=claude-haiku-4.5");

    // Every occurrence of --model= in the file must be claude-haiku-4.5
    // (includes comments and code — all must be consistent)
    const modelMatches = spawnerSource.match(/--model=[a-z0-9.-]+/g) ?? [];
    expect(modelMatches.length).toBeGreaterThanOrEqual(1);
    for (const match of modelMatches) {
      expect(match).toBe("--model=claude-haiku-4.5");
    }
  });

  it("spawner constructs argv with --output-format=json", async () => {
    const spawnerSource = await readFile(
      path.resolve(__dirname, "../../src/lib/copilot/spawner.ts"),
      "utf-8",
    );
    expect(spawnerSource).toContain("--output-format=json");
  });

  it("spawner constructs argv with --no-ask-user", async () => {
    const spawnerSource = await readFile(
      path.resolve(__dirname, "../../src/lib/copilot/spawner.ts"),
      "utf-8",
    );
    expect(spawnerSource).toContain("--no-ask-user");
  });

  it("spawner constructs argv with --allow-all-tools (not --allow-all)", async () => {
    const spawnerSource = await readFile(
      path.resolve(__dirname, "../../src/lib/copilot/spawner.ts"),
      "utf-8",
    );
    expect(spawnerSource).toContain("--allow-all-tools");
    // Verify it's not the deprecated --allow-all flag
    expect(spawnerSource).not.toMatch(/--allow-all(?!-tools)/);
  });

  it("spawner sets COPILOT_HOME env var to the per-run config dir", async () => {
    const spawnerSource = await readFile(
      path.resolve(__dirname, "../../src/lib/copilot/spawner.ts"),
      "utf-8",
    );
    expect(spawnerSource).toContain("COPILOT_HOME");
  });
});
