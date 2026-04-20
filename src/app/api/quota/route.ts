/**
 * GET /api/quota — Returns the current Copilot premium-request usage snapshot.
 *
 * Behavior:
 *   1. Return cached snapshot if fresh
 *   2. Otherwise fetch from GitHub billing API, normalize, cache, and return
 *   3. Degrade gracefully when credentials are missing or API is unavailable
 *
 * Design ref: QUOTA_HIGH_QUALITY_REFERENCE.md §7
 */

import { NextResponse } from "next/server";
import {
  fetchQuota,
  getCachedQuota,
  type QuotaApiResponse,
} from "@/lib/quota";

/** Resolve GitHub username — use env var or fall back to /user endpoint. */
async function resolveUsername(token: string): Promise<string | null> {
  const envUser = process.env.GITHUB_USERNAME?.trim();
  if (envUser) return envUser;

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { login?: string };
    return body.login ?? null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse<QuotaApiResponse>> {
  // 1. Return cached snapshot if still fresh
  const cached = getCachedQuota();
  if (cached) {
    return NextResponse.json({
      remaining: cached.remaining,
      limit: cached.limit,
      resetAt: cached.resetAt,
      scope: cached.scope,
      degraded: cached.degraded || undefined,
    });
  }

  // 2. Resolve credentials from environment (trim for CRLF .env files)
  const token = (process.env.GH_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN ?? "").trim();
  if (!token) {
    return NextResponse.json({
      remaining: null,
      limit: null,
      resetAt: new Date(
        Date.UTC(
          new Date().getUTCFullYear(),
          new Date().getUTCMonth() + 1,
          1,
        ),
      ).toISOString(),
      scope: "unknown",
      degraded: true,
    });
  }

  const user = await resolveUsername(token);
  if (!user) {
    return NextResponse.json({
      remaining: null,
      limit: null,
      resetAt: new Date(
        Date.UTC(
          new Date().getUTCFullYear(),
          new Date().getUTCMonth() + 1,
          1,
        ),
      ).toISOString(),
      scope: "unknown",
      degraded: true,
    });
  }

  // 3. Fetch, normalize, cache, return
  const snapshot = await fetchQuota({ user, token });

  return NextResponse.json({
    remaining: snapshot.remaining,
    limit: snapshot.limit,
    resetAt: snapshot.resetAt,
    scope: snapshot.scope,
    degraded: snapshot.degraded || undefined,
  });
}
