/**
 * zipper — Archiver wrapper for creating the final ZIP packet.
 *
 * Packs all filled PDFs from `runDir/out/`, plus `manifest.json`
 * and `transcript.jsonl` (if present), into a single ZIP file.
 */

import archiver from "archiver";
import { createWriteStream, readdirSync, existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZipPacketOptions {
  /** Unique run identifier. */
  runId: string;
  /** Directory containing filled PDF files. */
  outDir: string;
  /** Path to transcript.jsonl (optional — included if present). */
  transcriptPath?: string;
  /** Destination path for the ZIP file. */
  outputZipPath: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a ZIP packet containing all filled PDFs, a manifest, and the transcript.
 *
 * @returns Absolute path to the created ZIP file.
 * @throws If no PDF files are found in `outDir` or if archiver fails.
 */
export async function createZipPacket(
  options: ZipPacketOptions,
): Promise<string> {
  const { runId, outDir, transcriptPath, outputZipPath } = options;

  // Collect PDF files from the output directory
  const pdfFiles: string[] = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => f.toLowerCase().endsWith(".pdf"))
    : [];

  // Refuse to produce an empty packet — a zero-PDF ZIP indicates upstream
  // failure (filler stage produced nothing) and must not be silently sealed.
  if (pdfFiles.length === 0) {
    throw new Error(
      `createZipPacket: no PDF files found in outDir "${outDir}" — refusing to create empty packet.`,
    );
  }

  // Build manifest
  const manifest = {
    runId,
    created_at: new Date().toISOString(),
    files: pdfFiles.map((f) => ({ name: f, type: "filled_pdf" })),
  };

  // If transcript is available, include it in manifest
  if (transcriptPath && existsSync(transcriptPath)) {
    manifest.files.push({ name: "transcript.jsonl", type: "transcript" });
  }

  return new Promise<string>((resolve, reject) => {
    const output = createWriteStream(outputZipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => {
      resolve(outputZipPath);
    });

    output.on("error", (err: Error) => {
      reject(err);
    });

    archive.on("error", (err: Error) => {
      reject(err);
    });

    archive.pipe(output);

    // Add filled PDFs
    for (const pdf of pdfFiles) {
      archive.file(path.join(outDir, pdf), { name: pdf });
    }

    // Add manifest
    archive.append(JSON.stringify(manifest, null, 2), {
      name: "manifest.json",
    });

    // Add transcript if available
    if (transcriptPath && existsSync(transcriptPath)) {
      archive.file(transcriptPath, { name: "transcript.jsonl" });
    }

    void archive.finalize();
  });
}
