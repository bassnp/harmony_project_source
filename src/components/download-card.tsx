"use client";

/**
 * DownloadCard — Dashed-rectangle download icon-button.
 *
 * Enabled only when run status is `done` (zip.ready received).
 * Click → `window.location = /api/runs/:id/download`.
 */

import { Download } from "lucide-react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DownloadCardProps {
  /** Active run ID, or null when idle. */
  runId: string | null;
  /** Whether the ZIP is ready for download. */
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DownloadCard({ runId, ready }: DownloadCardProps) {
  const isEnabled = ready && runId != null;

  const handleClick = () => {
    if (!isEnabled) return;
    window.location.href = `/api/runs/${runId}/download`;
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!isEnabled}
      className={`flex h-48 w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors ${
        isEnabled
          ? "border-emerald-600 bg-neutral-900 text-emerald-400 hover:border-emerald-400 hover:text-emerald-300"
          : "cursor-not-allowed border-neutral-700 bg-neutral-900 text-neutral-600"
      }`}
    >
      <Download className="h-10 w-10" />
      <span className="text-sm font-medium">
        {isEnabled ? "Download ZIP" : "Download ZIP"}
      </span>
    </button>
  );
}
