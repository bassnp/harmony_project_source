import { NextResponse } from "next/server";
import { ensureStartupRecovery } from "@/lib/runs/startup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — Liveness probe for Docker healthcheck and load balancers.
 *
 * Also triggers one-time startup recovery on first call after process boot.
 * This ensures stale in-progress runs from a previous container lifecycle
 * are reset to `failed` before any user interaction.
 */
export async function GET() {
  ensureStartupRecovery();
  return NextResponse.json({ ok: true });
}
