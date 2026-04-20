/**
 * store — SQLite-backed persistence for run records.
 *
 * Uses `better-sqlite3` for zero-config, embedded, synchronous access.
 * Table is created lazily on first access (idempotent).
 *
 * Schema matches Phase P5 spec:
 *   id TEXT PRIMARY KEY, created_at INTEGER, status TEXT,
 *   input_pdf_name TEXT, extracted_json TEXT, approved_json TEXT,
 *   zip_path TEXT, error TEXT
 *
 * Ref: references/research/ORCHESTRATION_HIGH_QUALITY_REFERENCE.md §2.5
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid run status values. */
export type RunStatus =
  | "ingested"
  | "extracting"
  | "awaiting_human"
  | "filling"
  | "zipping"
  | "done"
  | "failed";

/** Shape of a run row as stored in SQLite. */
export interface RunRow {
  id: string;
  created_at: number;
  status: RunStatus;
  input_pdf_name: string | null;
  extracted_json: string | null;
  approved_json: string | null;
  zip_path: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Singleton database connection
// ---------------------------------------------------------------------------

/** Default SQLite path inside the container volume. */
const DEFAULT_DB_PATH = "/workspace/.app/history.sqlite";

let _db: DatabaseType | null = null;

/**
 * Get (or create) the singleton database connection.
 * Creates the parent directory and table on first call.
 */
export function getDb(dbPath?: string): DatabaseType {
  if (_db) return _db;

  const resolved = dbPath ?? DEFAULT_DB_PATH;
  mkdirSync(path.dirname(resolved), { recursive: true });

  _db = new Database(resolved);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      input_pdf_name TEXT,
      extracted_json TEXT,
      approved_json TEXT,
      zip_path TEXT,
      error TEXT
    );
  `);

  return _db;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/** Insert a new run record in `ingested` status. */
export function insertRun(id: string, inputPdfName: string): RunRow {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, created_at, status, input_pdf_name)
     VALUES (?, ?, 'ingested', ?)`,
  ).run(id, now, inputPdfName);

  return {
    id,
    created_at: now,
    status: "ingested",
    input_pdf_name: inputPdfName,
    extracted_json: null,
    approved_json: null,
    zip_path: null,
    error: null,
  };
}

/** Fetch a single run by ID. Returns `undefined` if not found. */
export function getRun(id: string): RunRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | RunRow
    | undefined;
}

/** List all runs, newest first. */
export function listRuns(): RunRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM runs ORDER BY created_at DESC")
    .all() as RunRow[];
}

/** Columns that may be updated via `updateRun`. Acts as a runtime allowlist
 *  to prevent SQL injection through dynamic column names. */
const UPDATABLE_COLUMNS: ReadonlySet<string> = new Set([
  "status",
  "extracted_json",
  "approved_json",
  "zip_path",
  "error",
]);

/** Update a run's status (and optionally other columns). */
export function updateRun(
  id: string,
  updates: Partial<
    Pick<RunRow, "status" | "extracted_json" | "approved_json" | "zip_path" | "error">
  >,
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!UPDATABLE_COLUMNS.has(key)) {
      throw new Error(`updateRun: disallowed column "${key}"`);
    }
    sets.push(`${key} = ?`);
    values.push(value);
  }

  if (sets.length === 0) return;
  values.push(id);

  db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

/**
 * Atomically transition a run's `status` from `from` to `to` in a single
 * SQL statement. Returns the number of rows changed (0 if the run was
 * not in `from`, 1 on success).
 *
 * Used by route handlers to eliminate read-then-write TOCTOU races
 * (e.g. concurrent approve/cancel double-taps).
 */
export function casStatus(
  id: string,
  from: RunStatus,
  to: RunStatus,
): number {
  const db = getDb();
  const result = db
    .prepare("UPDATE runs SET status = ? WHERE id = ? AND status = ?")
    .run(to, id, from);
  return result.changes;
}

/**
 * Atomically transition a run from any non-terminal status to `failed`,
 * setting the `error` column. Returns the number of rows changed.
 *
 * Used by `cancel` to avoid races with the orchestrator transitioning
 * the run between the existence check and the failure write.
 */
export function casFailFromNonTerminal(id: string, error: string): number {
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE runs SET status = 'failed', error = ? " +
        "WHERE id = ? AND status NOT IN ('done', 'failed')",
    )
    .run(error, id);
  return result.changes;
}

/**
 * Reset all in-progress runs to `failed` on service startup.
 *
 * When the container restarts (Docker restart, crash, RESTART_SERVICE.bat),
 * any runs in non-terminal, non-HITL states had their driving Copilot
 * child process killed. This function atomically marks them as failed
 * so the UI reflects an accurate state instead of being stuck forever.
 *
 * States reset: `ingested`, `extracting`, `filling`, `zipping`.
 * States preserved: `awaiting_human` (deliberate HITL pause — no process needed),
 *                   `done`, `failed` (terminal).
 *
 * Returns the number of runs that were reset.
 */
export function resetStaleRuns(reason: string): number {
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE runs SET status = 'failed', error = ? " +
        "WHERE status IN ('ingested', 'extracting', 'filling', 'zipping')",
    )
    .run(reason);
  return result.changes;
}

/** Reset the singleton connection (for testing). */
export function _resetDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
