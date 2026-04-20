/**
 * Unit tests for src/lib/runs/startup.ts — startup recovery guard.
 *
 * Uses an in-memory SQLite database to avoid filesystem side effects.
 * Verifies that stale in-progress runs are reset on first call,
 * `awaiting_human` and terminal states are preserved, and
 * the guard is idempotent (second call is a no-op).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock eventbus to avoid side effects in tests
vi.mock("@/lib/eventbus", () => {
  const publishMock = vi.fn().mockReturnValue({
    id: "mock-id",
    seq: 1,
    ts: new Date().toISOString(),
    channel: "run",
    type: "run.failed",
  });
  return {
    getEventBus: () => ({ publish: publishMock }),
    __publishMock: publishMock,
  };
});

import {
  getDb,
  insertRun,
  getRun,
  updateRun,
  _resetDb,
} from "@/lib/runs/store";
import { ensureStartupRecovery } from "@/lib/runs/startup";

// Access the mock
const eventbusMod = await import("@/lib/eventbus");
const publishMock = (eventbusMod as unknown as { __publishMock: ReturnType<typeof vi.fn> })
  .__publishMock;

describe("startup recovery", () => {
  const tmpDir = path.join(os.tmpdir(), `hcd-startup-test-${Date.now()}`);
  const dbPath = path.join(tmpDir, "test.sqlite");

  beforeEach(() => {
    _resetDb();
    // Reset the global guard so each test starts fresh
    globalThis.__hcdStartupRecoveryDone = undefined;
    mkdirSync(tmpDir, { recursive: true });
    getDb(dbPath);
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetDb();
    globalThis.__hcdStartupRecoveryDone = undefined;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resets 'extracting' runs to 'failed'", () => {
    insertRun("RUN_EXT", "test.pdf");
    updateRun("RUN_EXT", { status: "extracting" });

    const count = ensureStartupRecovery();

    expect(count).toBe(1);
    const run = getRun("RUN_EXT");
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("service restart");
  });

  it("resets 'ingested' runs to 'failed'", () => {
    insertRun("RUN_ING", "test.pdf");
    // ingested is the initial state, no update needed

    const count = ensureStartupRecovery();

    expect(count).toBe(1);
    const run = getRun("RUN_ING");
    expect(run?.status).toBe("failed");
  });

  it("resets 'filling' runs to 'failed'", () => {
    insertRun("RUN_FILL", "test.pdf");
    updateRun("RUN_FILL", { status: "filling" });

    const count = ensureStartupRecovery();

    expect(count).toBe(1);
    const run = getRun("RUN_FILL");
    expect(run?.status).toBe("failed");
  });

  it("resets 'zipping' runs to 'failed'", () => {
    insertRun("RUN_ZIP", "test.pdf");
    updateRun("RUN_ZIP", { status: "zipping" });

    const count = ensureStartupRecovery();

    expect(count).toBe(1);
    const run = getRun("RUN_ZIP");
    expect(run?.status).toBe("failed");
  });

  it("does NOT reset 'awaiting_human' runs", () => {
    insertRun("RUN_HITL", "test.pdf");
    updateRun("RUN_HITL", { status: "awaiting_human" });

    const count = ensureStartupRecovery();

    expect(count).toBe(0);
    const run = getRun("RUN_HITL");
    expect(run?.status).toBe("awaiting_human");
  });

  it("does NOT reset 'done' runs", () => {
    insertRun("RUN_DONE", "test.pdf");
    updateRun("RUN_DONE", { status: "done" });

    const count = ensureStartupRecovery();

    expect(count).toBe(0);
    const run = getRun("RUN_DONE");
    expect(run?.status).toBe("done");
  });

  it("does NOT reset 'failed' runs", () => {
    insertRun("RUN_FAIL", "test.pdf");
    updateRun("RUN_FAIL", { status: "failed", error: "previous error" });

    const count = ensureStartupRecovery();

    expect(count).toBe(0);
    const run = getRun("RUN_FAIL");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("previous error");
  });

  it("resets multiple stale runs in one call", () => {
    insertRun("RUN_A", "a.pdf");
    insertRun("RUN_B", "b.pdf");
    insertRun("RUN_C", "c.pdf");
    updateRun("RUN_A", { status: "extracting" });
    updateRun("RUN_B", { status: "filling" });
    updateRun("RUN_C", { status: "zipping" });

    const count = ensureStartupRecovery();

    expect(count).toBe(3);
    expect(getRun("RUN_A")?.status).toBe("failed");
    expect(getRun("RUN_B")?.status).toBe("failed");
    expect(getRun("RUN_C")?.status).toBe("failed");
  });

  it("is idempotent — second call returns 0", () => {
    insertRun("RUN_X", "test.pdf");
    updateRun("RUN_X", { status: "extracting" });

    const first = ensureStartupRecovery();
    expect(first).toBe(1);

    // Insert another stale run AFTER recovery has fired
    insertRun("RUN_Y", "test2.pdf");
    updateRun("RUN_Y", { status: "extracting" });

    const second = ensureStartupRecovery();
    expect(second).toBe(0); // Guard prevents re-execution
  });

  it("publishes run.failed events for each reset run", () => {
    insertRun("RUN_EVT1", "a.pdf");
    insertRun("RUN_EVT2", "b.pdf");
    updateRun("RUN_EVT1", { status: "extracting" });
    updateRun("RUN_EVT2", { status: "filling" });

    ensureStartupRecovery();

    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "run",
        type: "run.failed",
        runId: "RUN_EVT1",
      }),
    );
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "run",
        type: "run.failed",
        runId: "RUN_EVT2",
      }),
    );
  });

  it("returns 0 when no stale runs exist", () => {
    // Only terminal/HITL runs
    insertRun("RUN_OK1", "ok.pdf");
    insertRun("RUN_OK2", "ok.pdf");
    updateRun("RUN_OK1", { status: "done" });
    updateRun("RUN_OK2", { status: "awaiting_human" });

    const count = ensureStartupRecovery();
    expect(count).toBe(0);
    expect(publishMock).not.toHaveBeenCalled();
  });
});
