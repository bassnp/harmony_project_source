"use client";

/**
 * HistoryTable — Simple table of completed runs.
 *
 * Columns: Created, Source filename, Status, Download.
 * Fetches from GET /api/runs on mount.
 */

import { useEffect, useState, useCallback } from "react";
import { Download, RefreshCw } from "lucide-react";

// ---------------------------------------------------------------------------
// Types (mirrors RunRow subset)
// ---------------------------------------------------------------------------

interface RunSummary {
  id: string;
  created_at: number;
  status: string;
  input_pdf_name: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryTable() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);

  /** Fetch runs from API. Callable from event handlers (not effects). */
  const refreshRuns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/runs");
      if (res.ok) {
        const data = (await res.json()) as RunSummary[];
        setRuns(data);
      }
    } catch {
      // Silently handle fetch errors
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch on mount — runs once, result committed via .then() callback.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/runs")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: unknown) => {
        if (!cancelled) {
          setRuns(data as RunSummary[]);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-100">Run History</h2>
        <button
          type="button"
          onClick={() => void refreshRuns()}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>

      {loading && (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}

      {!loading && runs.length === 0 && (
        <p className="text-sm text-neutral-500">No runs yet.</p>
      )}

      {!loading && runs.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-neutral-700">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-700 bg-neutral-800 text-xs uppercase text-neutral-400">
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Source File</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Download</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className="border-b border-neutral-800 last:border-0"
                >
                  <td className="px-4 py-2 text-neutral-300">
                    {new Date(run.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-neutral-300">
                    {run.input_pdf_name ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-2">
                    {run.status === "done" ? (
                      <a
                        href={`/api/runs/${run.id}/download`}
                        className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300"
                      >
                        <Download className="h-3.5 w-3.5" />
                        ZIP
                      </a>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    done: "bg-emerald-900 text-emerald-400",
    failed: "bg-red-900 text-red-400",
    awaiting_human: "bg-yellow-900 text-yellow-400",
  };
  const cls = colors[status] ?? "bg-neutral-800 text-neutral-400";

  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
