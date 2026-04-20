/**
 * Quota fetcher — Calls the GitHub billing API and normalizes into QuotaSnapshot.
 *
 * Design ref: QUOTA_HIGH_QUALITY_REFERENCE.md §2–§5.
 *
 * Responsibilities:
 *   - Call GET /users/{user}/settings/billing/premium_request/usage
 *   - Parse usageItems, normalize provider ambiguity
 *   - Return a stable QuotaSnapshot regardless of upstream shape
 *   - Map 403/404 to a degraded managed-account snapshot (never throws)
 */

import type { QuotaSnapshot, QuotaScope } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

/**
 * Known monthly premium-request allowance for Copilot Pro individual plans.
 * GitHub does not return this value from the billing API — it only returns
 * usage items. The VS Code Copilot extension also hardcodes this value.
 */
const COPILOT_PRO_MONTHLY_LIMIT = 1780;

/** Candidate field names for the monthly limit (upstream naming varies). */
const LIMIT_CANDIDATES = [
  "total_monthly_quota",
  "totalMonthlyQuota",
  "monthly_quota",
  "monthlyQuota",
  "allowance",
  "limit",
] as const;

/** Candidate field names for remaining quota. */
const REMAINING_CANDIDATES = [
  "remaining_quota",
  "remainingQuota",
  "remaining",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the ISO 8601 timestamp for the first moment of the next UTC month.
 * This is the canonical quota reset boundary.
 */
export function nextUtcQuotaReset(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  ).toISOString();
}

/** Safely extract a numeric value from an object by trying multiple candidate keys. */
function pickNumeric(
  obj: Record<string, unknown>,
  candidates: readonly string[],
): number | null {
  for (const key of candidates) {
    const val = obj[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache — simple in-memory cache for the singleton process
// ---------------------------------------------------------------------------

/** Cache entry with expiry tracking. */
interface CacheEntry {
  snapshot: QuotaSnapshot;
  expiresAt: number; // epoch ms
}

let cache: CacheEntry | null = null;

/** Successful snapshot cache duration (seconds). */
const CACHE_OK_SECONDS = 300;
/** Degraded snapshot cache duration (seconds). */
const CACHE_DEGRADED_SECONDS = 60;

/** Return a cached snapshot if still fresh, else null. */
export function getCachedQuota(): QuotaSnapshot | null {
  if (!cache) return null;
  if (Date.now() > cache.expiresAt) {
    cache = null;
    return null;
  }
  return cache.snapshot;
}

/** Invalidate the cache (e.g. after agent completion or manual refresh). */
export function invalidateQuotaCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/** Build a degraded snapshot for managed / unsupported accounts. */
function buildDegradedSnapshot(reason: string): QuotaSnapshot {
  return {
    remaining: null,
    limit: null,
    resetAt: nextUtcQuotaReset(),
    scope: "managed-org-enterprise" as QuotaScope,
    degraded: true,
    fetchedAt: new Date().toISOString(),
    usedThisMonth: null,
    isPartial: false,
    isDerived: false,
    unsupportedReason: reason,
  };
}

/**
 * Fetch Copilot premium-request usage from GitHub's documented billing API.
 *
 * Returns a normalized QuotaSnapshot. Never throws — degrades gracefully
 * on 403/404 (managed accounts) or network errors.
 */
export async function fetchQuota(args: {
  user: string;
  token: string;
}): Promise<QuotaSnapshot> {
  // Strip trailing \r from env vars (Windows CRLF .env files parsed by Docker)
  const user = args.user.trim();
  const token = args.token.trim();

  // Guard: missing credentials
  if (!user || !token) {
    return buildDegradedSnapshot("Missing GitHub username or token");
  }

  const url = `${GITHUB_API_BASE}/users/${encodeURIComponent(user)}/settings/billing/premium_request/usage`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
  } catch {
    return buildDegradedSnapshot("Network error reaching GitHub API");
  }

  // 403 / 404 → managed account (documented behavior)
  if (res.status === 403 || res.status === 404) {
    const snapshot = buildDegradedSnapshot(
      "Managed account — quota not available via API",
    );
    cache = {
      snapshot,
      expiresAt: Date.now() + CACHE_DEGRADED_SECONDS * 1000,
    };
    return snapshot;
  }

  // Other non-OK → generic degraded
  if (!res.ok) {
    return buildDegradedSnapshot(
      `GitHub API returned HTTP ${res.status}`,
    );
  }

  // Parse the upstream response
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return buildDegradedSnapshot("Invalid JSON from GitHub API");
  }

  // Extract top-level limit and remaining via candidate keys
  const limit = pickNumeric(body, LIMIT_CANDIDATES);
  let remaining = pickNumeric(body, REMAINING_CANDIDATES);

  // Sum usageItems for usedThisMonth using grossQuantity (actual requests)
  // Note: netQuantity is 0 for fully discounted (included) plans — use gross.
  let usedThisMonth: number | null = null;
  const items = body.usageItems ?? body.usage_items;
  if (Array.isArray(items)) {
    usedThisMonth = 0;
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const gross = rec.grossQuantity ?? rec.gross_quantity;
      if (typeof gross === "number" && Number.isFinite(gross)) {
        usedThisMonth += gross;
      }
    }
    // Round to 1 decimal place to match VS Code display
    usedThisMonth = Math.round(usedThisMonth * 10) / 10;
  }

  // Use known Copilot Pro limit when API doesn't provide one
  const effectiveLimit = limit ?? COPILOT_PRO_MONTHLY_LIMIT;

  // Derive remaining if not directly available
  let isDerived = false;
  if (remaining === null && usedThisMonth !== null) {
    remaining = Math.max(effectiveLimit - usedThisMonth, 0);
    remaining = Math.round(remaining * 10) / 10;
    isDerived = true;
  }

  const snapshot: QuotaSnapshot = {
    remaining,
    limit: effectiveLimit,
    resetAt: nextUtcQuotaReset(),
    scope: "personal-user" as QuotaScope,
    degraded: false,
    fetchedAt: new Date().toISOString(),
    usedThisMonth,
    isPartial: remaining === null || limit === null,
    isDerived,
  };

  cache = {
    snapshot,
    expiresAt: Date.now() + CACHE_OK_SECONDS * 1000,
  };

  return snapshot;
}
