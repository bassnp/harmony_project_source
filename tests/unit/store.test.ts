/**
 * Unit tests for src/lib/runs/store.ts
 *
 * Uses an in-memory SQLite database to avoid filesystem side effects.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// We test the store by importing and resetting the singleton for each test.
import {
  getDb,
  insertRun,
  getRun,
  listRuns,
  updateRun,
  casStatus,
  casFailFromNonTerminal,
  _resetDb,
} from "@/lib/runs/store";

describe("store", () => {
  const tmpDir = path.join(os.tmpdir(), `hcd-store-test-${Date.now()}`);
  const dbPath = path.join(tmpDir, "test.sqlite");

  beforeEach(() => {
    _resetDb();
    mkdirSync(tmpDir, { recursive: true });
    // Initialize DB at the temp path
    getDb(dbPath);
  });

  afterEach(() => {
    _resetDb();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates the runs table on first getDb() call", () => {
    const db = getDb(dbPath);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='runs'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("inserts and retrieves a run", () => {
    const run = insertRun("TEST_001", "sample.pdf");
    expect(run.id).toBe("TEST_001");
    expect(run.status).toBe("ingested");
    expect(run.input_pdf_name).toBe("sample.pdf");

    const fetched = getRun("TEST_001");
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe("TEST_001");
    expect(fetched!.status).toBe("ingested");
  });

  it("returns undefined for non-existent run", () => {
    expect(getRun("NONEXISTENT")).toBeUndefined();
  });

  it("lists runs in newest-first order", () => {
    insertRun("RUN_A", "a.pdf");
    insertRun("RUN_B", "b.pdf");
    insertRun("RUN_C", "c.pdf");

    // Force distinct timestamps so ORDER BY created_at DESC is deterministic
    const db = getDb(dbPath);
    db.prepare("UPDATE runs SET created_at = 1000 WHERE id = 'RUN_A'").run();
    db.prepare("UPDATE runs SET created_at = 2000 WHERE id = 'RUN_B'").run();
    db.prepare("UPDATE runs SET created_at = 3000 WHERE id = 'RUN_C'").run();

    const runs = listRuns();
    expect(runs).toHaveLength(3);
    // Newest first: C (3000), B (2000), A (1000)
    expect(runs[0]!.id).toBe("RUN_C");
    expect(runs[1]!.id).toBe("RUN_B");
    expect(runs[2]!.id).toBe("RUN_A");
  });

  it("updates run fields", () => {
    insertRun("UPD_001", "test.pdf");
    updateRun("UPD_001", {
      status: "extracting",
      extracted_json: '{"decal_number":"123"}',
    });

    const run = getRun("UPD_001");
    expect(run!.status).toBe("extracting");
    expect(run!.extracted_json).toBe('{"decal_number":"123"}');
  });

  it("handles empty update gracefully", () => {
    insertRun("EMPTY_UPD", "test.pdf");
    // Should not throw
    updateRun("EMPTY_UPD", {});
    const run = getRun("EMPTY_UPD");
    expect(run!.status).toBe("ingested");
  });

  it("rejects update with disallowed column name (SQL injection guard)", () => {
    insertRun("INJECT_001", "test.pdf");
    // Cast to bypass TypeScript — simulates runtime injection at boundary
    expect(() =>
      updateRun("INJECT_001", { "status; DROP TABLE runs; --": "oops" } as never),
    ).toThrow(/disallowed column/);
  });

  it("allows all legitimate columns in a single update", () => {
    insertRun("MULTI_UPD", "test.pdf");
    updateRun("MULTI_UPD", {
      status: "extracting",
      extracted_json: '{"a":1}',
      approved_json: null,
      zip_path: null,
      error: null,
    });
    const run = getRun("MULTI_UPD");
    expect(run!.status).toBe("extracting");
    expect(run!.extracted_json).toBe('{"a":1}');
  });

  it("insertRun rejects duplicate IDs", () => {
    insertRun("DUP_001", "a.pdf");
    expect(() => insertRun("DUP_001", "b.pdf")).toThrow();
  });

  it("stores and retrieves large extracted_json values", () => {
    insertRun("BIG_JSON", "test.pdf");
    const bigJson = JSON.stringify({ data: "x".repeat(50_000) });
    updateRun("BIG_JSON", { extracted_json: bigJson });
    const run = getRun("BIG_JSON");
    expect(run!.extracted_json).toBe(bigJson);
  });

  // ---------------------------------------------------------------------------
  // CAS — atomic compare-and-set transitions (race protection)
  // ---------------------------------------------------------------------------

  it("casStatus returns 1 and updates when current status matches", () => {
    insertRun("CAS_OK", "x.pdf");
    updateRun("CAS_OK", { status: "awaiting_human" });
    const changed = casStatus("CAS_OK", "awaiting_human", "filling");
    expect(changed).toBe(1);
    expect(getRun("CAS_OK")!.status).toBe("filling");
  });

  it("casStatus returns 0 and leaves the row untouched when status mismatches", () => {
    insertRun("CAS_MISS", "x.pdf");
    updateRun("CAS_MISS", { status: "filling" });
    const changed = casStatus("CAS_MISS", "awaiting_human", "filling");
    expect(changed).toBe(0);
    expect(getRun("CAS_MISS")!.status).toBe("filling");
  });

  it("casStatus is single-winner under simulated concurrent calls", () => {
    insertRun("CAS_RACE", "x.pdf");
    updateRun("CAS_RACE", { status: "awaiting_human" });
    // Two synchronous CAS calls — better-sqlite3 is sync, so the second
    // executes against the post-first-call state.
    const a = casStatus("CAS_RACE", "awaiting_human", "filling");
    const b = casStatus("CAS_RACE", "awaiting_human", "filling");
    expect(a + b).toBe(1); // exactly one winner
    expect(getRun("CAS_RACE")!.status).toBe("filling");
  });

  it("casStatus returns 0 for unknown id without throwing", () => {
    expect(casStatus("DOES_NOT_EXIST", "ingested", "extracting")).toBe(0);
  });

  it("casFailFromNonTerminal succeeds for non-terminal status and writes error", () => {
    insertRun("CANCEL_OK", "x.pdf");
    updateRun("CANCEL_OK", { status: "extracting" });
    const changed = casFailFromNonTerminal("CANCEL_OK", "user cancel");
    expect(changed).toBe(1);
    const row = getRun("CANCEL_OK")!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("user cancel");
  });

  it("casFailFromNonTerminal is a no-op on terminal status", () => {
    insertRun("CANCEL_DONE", "x.pdf");
    updateRun("CANCEL_DONE", { status: "done", zip_path: "/tmp/p.zip" });
    expect(casFailFromNonTerminal("CANCEL_DONE", "user cancel")).toBe(0);
    const row = getRun("CANCEL_DONE")!;
    expect(row.status).toBe("done");
    expect(row.error).toBeNull();
  });
});
