/**
 * POST /api/runs — Create a new run (multipart file upload).
 * GET  /api/runs — List all runs (newest first).
 *
 * POST accepts a `file` field (PDF) via multipart/form-data.
 * Validates file presence and type with Zod, persists to
 * `/workspace/runs/<id>/input.pdf`, inserts a DB record,
 * and kicks off the orchestrator pipeline (fire-and-forget).
 *
 * Ref: references/research/NEXTJS_BACKEND_HIGH_QUALITY_REFERENCE.md §3
 * Ref: references/research/ORCHESTRATION_HIGH_QUALITY_REFERENCE.md §4
 */

import { type NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { generateRunId } from "@/lib/runs/ids";
import { insertRun, listRuns } from "@/lib/runs/store";
import { advanceRun, runDir } from "@/lib/runs/stateMachine";
import { ensureStartupRecovery } from "@/lib/runs/startup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Zod schema for the uploaded file metadata (validated after extraction). */
const UploadSchema = z.object({
  name: z.string().min(1, "Filename is required"),
  size: z.number().int().positive("File must not be empty").max(
    25 * 1024 * 1024,
    "File exceeds 25 MB limit",
  ),
  type: z.string().refine(
    (t) => t === "application/pdf",
    "Only PDF files are accepted",
  ),
});

// ---------------------------------------------------------------------------
// POST /api/runs — Create a new run
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart form data" },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing 'file' field in form data" },
      { status: 400 },
    );
  }

  // Validate file metadata
  const validation = UploadSchema.safeParse({
    name: file.name,
    size: file.size,
    type: file.type,
  });
  if (!validation.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: validation.error.issues },
      { status: 400 },
    );
  }

  // Generate run ID and persist the file
  const id = generateRunId();
  const dir = runDir(id);

  // Read into memory once so we can validate the magic bytes BEFORE we
  // create any on-disk artifacts. Otherwise a rejected upload still leaves
  // an empty `/workspace/runs/<id>/` directory.
  const buffer = Buffer.from(await file.arrayBuffer());

  // Magic-byte check: a real PDF must begin with "%PDF-" (0x25 50 44 46 2D).
  // The Content-Type field is purely client-asserted, so without this guard a
  // text file uploaded with `;type=application/pdf` would be persisted and
  // shipped to Copilot, which then fails deep inside extraction with a
  // confusing schema error. Reject early with a clear 400.
  if (
    buffer.length < 5 ||
    buffer[0] !== 0x25 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x44 ||
    buffer[3] !== 0x46 ||
    buffer[4] !== 0x2d
  ) {
    return NextResponse.json(
      { error: "File content is not a valid PDF (missing %PDF- header)" },
      { status: 400 },
    );
  }

  await mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, "input.pdf");
  await writeFile(inputPath, buffer);

  // Insert DB record
  const run = insertRun(id, file.name);

  // Fire-and-forget: advance the pipeline asynchronously
  advanceRun(id).catch((err: unknown) => {
    console.error(`[runs/route] advanceRun failed for ${id}:`, err);
  });

  return NextResponse.json(
    { id: run.id, status: run.status, created_at: run.created_at },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET /api/runs — List all runs
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  ensureStartupRecovery();
  const runs = listRuns();
  return NextResponse.json(runs);
}
