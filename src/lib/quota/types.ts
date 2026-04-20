/**
 * Quota types — Shared type definitions for Copilot Premium Requests usage.
 *
 * Follows the canonical shape from QUOTA_HIGH_QUALITY_REFERENCE.md §2–§3.
 * All quota reads normalize into these types regardless of upstream provider.
 */

// ---------------------------------------------------------------------------
// Scope — billing context for the authenticated user
// ---------------------------------------------------------------------------

/** Billing scope for the GitHub Copilot subscription. */
export type QuotaScope =
  | "personal-user"
  | "managed-org-enterprise"
  | "unknown";

// ---------------------------------------------------------------------------
// API response — public contract returned by GET /api/quota
// ---------------------------------------------------------------------------

/** Canonical response shape for the quota route and UI consumers. */
export interface QuotaApiResponse {
  /** Remaining premium requests this billing period, or null if unavailable. */
  remaining: number | null;
  /** Total monthly premium request allowance, or null if unavailable. */
  limit: number | null;
  /** ISO 8601 timestamp of the next quota reset (first of next UTC month). */
  resetAt: string;
  /** Billing scope of the authenticated user. */
  scope: QuotaScope;
  /** True when the quota endpoint returned 403/404 (managed account). */
  degraded?: boolean;
}

// ---------------------------------------------------------------------------
// Internal snapshot — richer shape held in the server-side cache
// ---------------------------------------------------------------------------

/** Full internal snapshot stored by the fetcher/cache layer. */
export interface QuotaSnapshot extends QuotaApiResponse {
  /** ISO 8601 timestamp when this snapshot was fetched. */
  fetchedAt: string;
  /** Computed used count this month, or null if unavailable. */
  usedThisMonth: number | null;
  /** True if the snapshot was partially derived (e.g. remaining = limit - used). */
  isPartial: boolean;
  /** True if remaining was computed rather than read directly from the API. */
  isDerived: boolean;
  /** Human-readable reason when degraded is true. */
  unsupportedReason?: string;
}
