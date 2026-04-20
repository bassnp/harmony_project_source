/**
 * Unit tests for src/lib/pdf/zipper.ts
 */
import { describe, it, expect, afterEach } from "vitest";
import { createZipPacket } from "@/lib/pdf/zipper";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("zipper — createZipPacket()", () => {
  const tmpDir = path.join(os.tmpdir(), `hcd-zipper-test-${Date.now()}`);
  const outDir = path.join(tmpDir, "out");

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates a ZIP with PDFs and manifest", async () => {
    mkdirSync(outDir, { recursive: true });
    // Create dummy PDF files
    writeFileSync(path.join(outDir, "476.6G.pdf"), "fake-pdf-1");
    writeFileSync(path.join(outDir, "476.6.pdf"), "fake-pdf-2");
    writeFileSync(path.join(outDir, "480.5.pdf"), "fake-pdf-3");

    const zipPath = path.join(tmpDir, "packet.zip");
    const result = await createZipPacket({
      runId: "TEST_ZIP_001",
      outDir,
      outputZipPath: zipPath,
    });

    expect(result).toBe(zipPath);
    expect(existsSync(zipPath)).toBe(true);

    // Verify it's a valid ZIP (starts with PK signature)
    const zipBuffer = readFileSync(zipPath);
    expect(zipBuffer[0]).toBe(0x50); // 'P'
    expect(zipBuffer[1]).toBe(0x4b); // 'K'
  });

  it("includes transcript when provided", async () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "test.pdf"), "fake-pdf");
    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    writeFileSync(transcriptPath, '{"type":"test"}\n');

    const zipPath = path.join(tmpDir, "packet-with-transcript.zip");
    await createZipPacket({
      runId: "TEST_ZIP_002",
      outDir,
      transcriptPath,
      outputZipPath: zipPath,
    });

    expect(existsSync(zipPath)).toBe(true);
  });

  it("refuses to create a ZIP when outDir contains no PDFs", async () => {
    mkdirSync(outDir, { recursive: true });

    const zipPath = path.join(tmpDir, "empty-packet.zip");
    await expect(
      createZipPacket({
        runId: "TEST_ZIP_003",
        outDir,
        outputZipPath: zipPath,
      }),
    ).rejects.toThrow(/no PDF files found/i);

    expect(existsSync(zipPath)).toBe(false);
  });

  it("handles non-existent outDir gracefully (empty packet rejection)", async () => {
    const nonExistentDir = path.join(tmpDir, "does-not-exist");
    const zipPath = path.join(tmpDir, "no-dir-packet.zip");
    await expect(
      createZipPacket({
        runId: "TEST_ZIP_004",
        outDir: nonExistentDir,
        outputZipPath: zipPath,
      }),
    ).rejects.toThrow(/no PDF files found/i);
  });

  it("ignores non-PDF files in outDir", async () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "readme.txt"), "not a pdf");
    writeFileSync(path.join(outDir, "476.6G.pdf"), "fake-pdf");

    const zipPath = path.join(tmpDir, "mixed-packet.zip");
    const result = await createZipPacket({
      runId: "TEST_ZIP_005",
      outDir,
      outputZipPath: zipPath,
    });
    expect(result).toBe(zipPath);
    expect(existsSync(zipPath)).toBe(true);
  });

  it("skips transcript in manifest when file does not exist", async () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "test.pdf"), "fake-pdf");

    const zipPath = path.join(tmpDir, "no-transcript-packet.zip");
    await createZipPacket({
      runId: "TEST_ZIP_006",
      outDir,
      transcriptPath: path.join(tmpDir, "nonexistent-transcript.jsonl"),
      outputZipPath: zipPath,
    });

    expect(existsSync(zipPath)).toBe(true);
  });
});
