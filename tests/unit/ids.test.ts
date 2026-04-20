/**
 * Unit tests for src/lib/runs/ids.ts
 */
import { describe, it, expect } from "vitest";
import { generateRunId, isValidRunId } from "@/lib/runs/ids";

describe("generateRunId", () => {
  it("returns a 26-character ULID string", () => {
    const id = generateRunId();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it("generates unique IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRunId()));
    expect(ids.size).toBe(100);
  });

  it("generates lexicographically ordered IDs", () => {
    const a = generateRunId();
    const b = generateRunId();
    expect(b >= a).toBe(true);
  });
});

describe("isValidRunId", () => {
  it("accepts a freshly generated ULID", () => {
    expect(isValidRunId(generateRunId())).toBe(true);
  });

  it("rejects empty / wrong-length / non-string values", () => {
    expect(isValidRunId("")).toBe(false);
    expect(isValidRunId("ABC")).toBe(false);
    expect(isValidRunId("A".repeat(27))).toBe(false);
    // @ts-expect-error — runtime guard against non-string id
    expect(isValidRunId(undefined)).toBe(false);
  });

  it("rejects path-traversal and control-character payloads", () => {
    expect(isValidRunId("../../etc/passwd")).toBe(false);
    expect(isValidRunId("evil\nSet-Cookie:x=1")).toBe(false);
    expect(isValidRunId("<script>alert(1)</script>")).toBe(false);
  });

  it("rejects ULID-shaped strings using forbidden Crockford chars", () => {
    // 'I', 'L', 'O', 'U' are excluded from Crockford base32.
    const base = "01ARZ3NDEKTSV4RRFFQ69G5FA";
    expect(isValidRunId(base + "I")).toBe(false);
    expect(isValidRunId(base + "L")).toBe(false);
    expect(isValidRunId(base + "O")).toBe(false);
    expect(isValidRunId(base + "U")).toBe(false);
  });
});
