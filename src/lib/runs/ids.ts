/**
 * ids — ULID-based run ID generator.
 *
 * ULIDs are lexicographically sortable (time-ordered) and URL-safe,
 * making them ideal for run identifiers that double as directory names.
 *
 * Uses `monotonicFactory()` so multiple IDs minted in the same millisecond
 * remain strictly increasing — required for SQLite ORDER BY id and for
 * the History view's chronological ordering.
 */

import { monotonicFactory } from "ulid";

const monotonicUlid = monotonicFactory();

/** Generate a new monotonically-increasing ULID run identifier. */
export function generateRunId(): string {
  return monotonicUlid();
}

/**
 * Crockford-base32 ULID format: 26 chars, no I/L/O/U.
 *
 * Used as a defense-in-depth guard on every `[id]` route param so we
 * (a) never reflect arbitrary attacker-controlled bytes back into JSON
 * error responses or server logs, and (b) never `path.join()` an
 * unsanitized id into a workspace filesystem path. The DB lookup
 * already filters unknown ids to 404, but format validation runs first
 * to short-circuit obvious abuse (length-amplification, traversal,
 * control characters) before touching SQLite or the filesystem.
 */
const RUN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Returns `true` iff `id` is a syntactically valid ULID. */
export function isValidRunId(id: string): boolean {
  return typeof id === "string" && RUN_ID_PATTERN.test(id);
}
