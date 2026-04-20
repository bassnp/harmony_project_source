/**
 * Unit tests for src/lib/quota — fetcher, cache, and reset helper.
 *
 * Tests cover:
 *   - nextUtcQuotaReset computation
 *   - Happy path: successful API response → QuotaSnapshot
 *   - Degraded path: 403/404 → managed-account snapshot
 *   - Missing credentials → graceful degradation
 *   - Cache behavior (fresh vs. expired)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  nextUtcQuotaReset,
  fetchQuota,
  getCachedQuota,
  invalidateQuotaCache,
} from "@/lib/quota";

// ---------------------------------------------------------------------------
// nextUtcQuotaReset
// ---------------------------------------------------------------------------

describe("nextUtcQuotaReset", () => {
  it("returns the first day of the next UTC month", () => {
    const jan15 = new Date(Date.UTC(2026, 0, 15)); // Jan 15, 2026
    const result = nextUtcQuotaReset(jan15);
    expect(result).toBe("2026-02-01T00:00:00.000Z");
  });

  it("rolls over to the next year in December", () => {
    const dec25 = new Date(Date.UTC(2026, 11, 25)); // Dec 25, 2026
    const result = nextUtcQuotaReset(dec25);
    expect(result).toBe("2027-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// fetchQuota — mock global fetch
// ---------------------------------------------------------------------------

describe("fetchQuota", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    invalidateQuotaCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a degraded snapshot when credentials are missing", async () => {
    const snap = await fetchQuota({ user: "", token: "" });
    expect(snap.degraded).toBe(true);
    expect(snap.remaining).toBeNull();
    expect(snap.limit).toBeNull();
    expect(snap.unsupportedReason).toBe(
      "Missing GitHub username or token",
    );
  });

  it("returns a degraded snapshot on HTTP 403", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    } as Response);

    const snap = await fetchQuota({ user: "testuser", token: "tok_123" });
    expect(snap.degraded).toBe(true);
    expect(snap.scope).toBe("managed-org-enterprise");
    expect(snap.unsupportedReason).toContain("Managed account");
  });

  it("returns a degraded snapshot on HTTP 404", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    const snap = await fetchQuota({ user: "testuser", token: "tok_123" });
    expect(snap.degraded).toBe(true);
    expect(snap.scope).toBe("managed-org-enterprise");
  });

  it("parses a successful response into a QuotaSnapshot", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        timePeriod: { year: 2026, month: 4 },
        user: "testuser",
        usageItems: [
          { model: "Claude Haiku 4.5", grossQuantity: 5.61, netQuantity: 0 },
          { model: "Claude Opus 4.6", grossQuantity: 57.0, netQuantity: 0 },
          { model: "Claude Opus 4.7", grossQuantity: 30.0, netQuantity: 0 },
        ],
      }),
    } as Response);

    const snap = await fetchQuota({ user: "testuser", token: "tok_123" });
    expect(snap.degraded).toBe(false);
    expect(snap.limit).toBe(1780); // Copilot Pro monthly limit
    expect(snap.usedThisMonth).toBe(92.6); // 5.61 + 57 + 30 rounded
    expect(snap.remaining).toBe(1687.4); // 1780 - 92.6
    expect(snap.isDerived).toBe(true);
    expect(snap.scope).toBe("personal-user");
  });

  it("derives remaining from limit minus used when remaining absent", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        usageItems: [{ grossQuantity: 100 }],
      }),
    } as Response);

    const snap = await fetchQuota({ user: "testuser", token: "tok_123" });
    expect(snap.remaining).toBe(1680); // 1780 - 100
    expect(snap.limit).toBe(1780);
    expect(snap.isDerived).toBe(true);
  });

  it("returns a degraded snapshot on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const snap = await fetchQuota({ user: "testuser", token: "tok_123" });
    expect(snap.degraded).toBe(true);
    expect(snap.unsupportedReason).toContain("Network error");
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe("getCachedQuota / invalidateQuotaCache", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    invalidateQuotaCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when cache is empty", () => {
    expect(getCachedQuota()).toBeNull();
  });

  it("returns cached snapshot after a successful fetch", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        usageItems: [{ grossQuantity: 50 }],
      }),
    } as Response);

    await fetchQuota({ user: "testuser", token: "tok_123" });
    const cached = getCachedQuota();
    expect(cached).not.toBeNull();
    expect(cached?.remaining).toBe(1730); // 1780 - 50
  });

  it("returns null after invalidation", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ usageItems: [{ grossQuantity: 50 }] }),
    } as Response);

    await fetchQuota({ user: "testuser", token: "tok_123" });
    invalidateQuotaCache();
    expect(getCachedQuota()).toBeNull();
  });
});
