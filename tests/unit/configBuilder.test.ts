/**
 * configBuilder.test.ts — Unit tests for MCP config materialization.
 */

import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRunConfig, buildMcpConfig } from "@/lib/copilot/configBuilder";
import type { CopilotMcpConfig } from "@/lib/copilot/configBuilder";

describe("configBuilder", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  describe("buildMcpConfig()", () => {
    it("returns config with both MCP servers", () => {
      const config = buildMcpConfig();

      expect(config.mcpServers).toBeDefined();
      expect(Object.keys(config.mcpServers)).toHaveLength(2);
      expect(config.mcpServers["mcp-pdf"]).toBeDefined();
      expect(config.mcpServers["pymupdf4llm"]).toBeDefined();
    });

    it("mcp-pdf uses uvx stdio transport", () => {
      const config = buildMcpConfig();
      const mcpPdf = config.mcpServers["mcp-pdf"]!;

      expect(mcpPdf.type).toBe("stdio");
      expect(mcpPdf.command).toBe("uvx");
      expect(mcpPdf.args).toContain("mcp-pdf[forms]");
      expect(mcpPdf.tools).toBeUndefined();
    });

    it("pymupdf4llm uses uvx stdio transport", () => {
      const config = buildMcpConfig();
      const pymupdf = config.mcpServers["pymupdf4llm"]!;

      expect(pymupdf.type).toBe("stdio");
      expect(pymupdf.command).toBe("uvx");
      expect(pymupdf.args).toContain("pymupdf4llm-mcp@latest");
      expect(pymupdf.args).toContain("stdio");
    });

    it("returns a fresh copy each call (no shared mutation)", () => {
      const a = buildMcpConfig();
      const b = buildMcpConfig();

      expect(a).toEqual(b);
      expect(a.mcpServers).not.toBe(b.mcpServers);
    });
  });

  describe("buildRunConfig()", () => {
    it("creates per-run .copilot directory with mcp-config.json", async () => {
      const base = await mkdtemp(path.join(tmpdir(), "cfg-test-"));
      tempDirs.push(base);

      const runId = "test-run-001";
      const copilotDir = await buildRunConfig({ runId, baseDir: base });

      expect(copilotDir).toBe(path.join(base, runId, ".copilot"));

      const raw = await readFile(
        path.join(copilotDir, "mcp-config.json"),
        "utf-8",
      );
      const config = JSON.parse(raw) as CopilotMcpConfig;

      expect(config.mcpServers).toBeDefined();
      expect(Object.keys(config.mcpServers)).toHaveLength(2);
    });

    it("isolates concurrent runs to separate directories", async () => {
      const base = await mkdtemp(path.join(tmpdir(), "cfg-test-"));
      tempDirs.push(base);

      const dirA = await buildRunConfig({ runId: "run-a", baseDir: base });
      const dirB = await buildRunConfig({ runId: "run-b", baseDir: base });

      expect(dirA).not.toBe(dirB);
      expect(dirA).toContain("run-a");
      expect(dirB).toContain("run-b");
    });

    it("is idempotent — re-running for same runId overwrites cleanly", async () => {
      const base = await mkdtemp(path.join(tmpdir(), "cfg-test-"));
      tempDirs.push(base);

      const dir1 = await buildRunConfig({ runId: "idempotent", baseDir: base });
      const dir2 = await buildRunConfig({ runId: "idempotent", baseDir: base });

      expect(dir1).toBe(dir2);

      const raw = await readFile(
        path.join(dir1, "mcp-config.json"),
        "utf-8",
      );
      const config = JSON.parse(raw) as CopilotMcpConfig;
      expect(Object.keys(config.mcpServers)).toHaveLength(2);
    });

    it("rejects empty runId", async () => {
      await expect(
        buildRunConfig({ runId: "", baseDir: tmpdir() }),
      ).rejects.toThrow(/Invalid runId/);
    });

    it("rejects path-traversal runId", async () => {
      await expect(
        buildRunConfig({ runId: "../../etc", baseDir: tmpdir() }),
      ).rejects.toThrow(/Invalid runId/);
    });

    it("rejects runId with slashes", async () => {
      await expect(
        buildRunConfig({ runId: "foo/bar", baseDir: tmpdir() }),
      ).rejects.toThrow(/Invalid runId/);
    });

    it("rejects runId with spaces", async () => {
      await expect(
        buildRunConfig({ runId: "has spaces", baseDir: tmpdir() }),
      ).rejects.toThrow(/Invalid runId/);
    });

    it("accepts valid ULID runId", async () => {
      const base = await mkdtemp(path.join(tmpdir(), "cfg-test-"));
      tempDirs.push(base);

      const dir = await buildRunConfig({
        runId: "01HXZ3Y4P8QRSTUVWXYZ1234AB",
        baseDir: base,
      });
      expect(dir).toContain("01HXZ3Y4P8QRSTUVWXYZ1234AB");
    });

    it("rejects runId with backticks (shell injection)", async () => {
      await expect(
        buildRunConfig({ runId: "`whoami`", baseDir: tmpdir() }),
      ).rejects.toThrow(/Invalid runId/);
    });

    it("rejects runId with null bytes", async () => {
      await expect(
        buildRunConfig({ runId: "run\x00id", baseDir: tmpdir() }),
      ).rejects.toThrow(/Invalid runId/);
    });

    it("rejects runId exceeding 128 chars", async () => {
      await expect(
        buildRunConfig({ runId: "A".repeat(129), baseDir: tmpdir() }),
      ).rejects.toThrow(/Invalid runId/);
    });

    it("accepts runId at exactly 128 chars", async () => {
      const base = await mkdtemp(path.join(tmpdir(), "cfg-test-"));
      tempDirs.push(base);
      const longId = "A".repeat(128);
      const dir = await buildRunConfig({ runId: longId, baseDir: base });
      expect(dir).toContain(longId);
    });

    it("mcp-config.json contains valid JSON with expected structure", async () => {
      const base = await mkdtemp(path.join(tmpdir(), "cfg-test-"));
      tempDirs.push(base);

      const copilotDir = await buildRunConfig({ runId: "json-check", baseDir: base });
      const raw = await readFile(path.join(copilotDir, "mcp-config.json"), "utf-8");
      const config = JSON.parse(raw);

      expect(config).toHaveProperty("mcpServers");
      expect(config.mcpServers["mcp-pdf"].command).toBe("uvx");
      expect(config.mcpServers["pymupdf4llm"].command).toBe("uvx");
    });
  });
});
