"use client";

/**
 * /new — New Title workspace page.
 *
 * Two-column layout: UploadCard (left) + DownloadCard (right).
 * ProgressBar across the top. HITL modal on `human.prompt` event.
 *
 * Persists `runId` in localStorage so reload re-attaches the SSE stream.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { UploadCard } from "@/components/upload-card";
import { DownloadCard } from "@/components/download-card";
import { ProgressBar } from "@/components/progress-bar";
import { HitlModal } from "@/components/hitl-modal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractedFields {
  decal_number: string;
  serial_number: string;
  trade_name?: string;
  manufacturer_name?: string;
  manufacture_date?: string;
  model_name?: string;
  owners: { name: string; [k: string]: string | undefined }[];
  situs_address?: string;
  situs_city?: string;
  situs_state?: string;
  situs_zip?: string;
  sale_price?: string;
  sale_date?: string;
  notes?: string;
}

interface RunInfo {
  id: string;
  status: string;
  extracted_json?: string | null;
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const LS_KEY = "hcd_current_run_id";

function loadRunId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(LS_KEY);
}

function saveRunId(id: string | null) {
  if (typeof window === "undefined") return;
  if (id) localStorage.setItem(LS_KEY, id);
  else localStorage.removeItem(LS_KEY);
  // Notify ShellLayout ThoughtPanel of the change
  window.dispatchEvent(new Event("hcd-run-changed"));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NewTitlePage() {
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [zipReady, setZipReady] = useState(false);
  const [hitlOpen, setHitlOpen] = useState(false);
  const [hitlFields, setHitlFields] = useState<ExtractedFields | null>(null);
  const [originalFields, setOriginalFields] = useState<ExtractedFields | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // --- Hydrate from localStorage on mount -----------------------------------
  useEffect(() => {
    const saved = loadRunId();
    if (saved) {
      // Fetch current status to rehydrate UI
      void (async () => {
        try {
          const res = await fetch(`/api/runs/${saved}`);
          if (res.ok) {
            const data = (await res.json()) as RunInfo;
            setRunId(data.id);
            setStatus(data.status);
            if (data.status === "done") setZipReady(true);
            if (data.status === "awaiting_human" && data.extracted_json) {
              const parsed = JSON.parse(data.extracted_json) as ExtractedFields;
              setHitlFields(parsed);
              setOriginalFields(structuredClone(parsed));
              setHitlOpen(true);
            }
            if (data.status === "failed") {
              setErrorMsg((data as { error?: string }).error ?? "Run failed");
            }
          } else {
            // Run no longer exists — clear
            saveRunId(null);
          }
        } catch {
          // Try the list endpoint as fallback for status
          try {
            const listRes = await fetch("/api/runs");
            if (listRes.ok) {
              const runs = (await listRes.json()) as RunInfo[];
              const found = runs.find((r) => r.id === saved);
              if (found) {
                setRunId(found.id);
                setStatus(found.status);
                if (found.status === "done") setZipReady(true);
              } else {
                saveRunId(null);
              }
            }
          } catch {
            saveRunId(null);
          }
        }
      })();
    }
  }, []);

  // --- SSE subscription to track run status ----------------------------------
  const subscribeSSE = useCallback((id: string) => {
    // Close any existing connection
    esRef.current?.close();

    const es = new EventSource(`/api/runs/${id}/events`);
    esRef.current = es;

    const handleRun = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data as string) as {
          type: string;
          payload?: unknown;
        };
        // Map run.* events to status updates
        const statusMatch = /^run\.(.+)$/.exec(data.type);
        if (statusMatch) {
          const newStatus = statusMatch[1]!;
          setStatus(newStatus);
          if (newStatus === "done") setZipReady(true);
          if (newStatus === "failed") {
            const p = data.payload as { error?: string } | undefined;
            setErrorMsg(p?.error ?? "Run failed");
          }
        }
        // HITL prompt
        if (data.type === "human.prompt") {
          const p = data.payload as { fields?: ExtractedFields } | undefined;
          if (p?.fields) {
            setHitlFields(p.fields);
            setOriginalFields(structuredClone(p.fields));
            setHitlOpen(true);
          }
        }
        // ZIP ready
        if (data.type === "zip.ready") {
          setZipReady(true);
        }
      } catch {
        // Malformed event — skip
      }
    };

    es.addEventListener("run", handleRun);

    es.onerror = () => {
      // EventSource auto-reconnects.
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  // Subscribe when runId changes
  useEffect(() => {
    if (!runId) return;
    const cleanup = subscribeSSE(runId);
    return cleanup;
  }, [runId, subscribeSSE]);

  // --- Listen for ThoughtPanel "Review & Approve" button --------------------
  // The HitlNodeView dispatches `hcd-hitl-open` to re-open the HITL modal
  // when the user clicks the approval button in the right-hand timeline.
  useEffect(() => {
    const handleHitlOpen = () => {
      if (hitlFields) setHitlOpen(true);
    };
    window.addEventListener("hcd-hitl-open", handleHitlOpen);
    return () => window.removeEventListener("hcd-hitl-open", handleHitlOpen);
  }, [hitlFields]);

  // --- Handlers --------------------------------------------------------------
  const handleUploaded = (newRunId: string) => {
    setRunId(newRunId);
    setStatus("ingested");
    setZipReady(false);
    setHitlOpen(false);
    setHitlFields(null);
    setOriginalFields(null);
    setErrorMsg(null);
    saveRunId(newRunId);
  };

  const handleUploadError = (msg: string) => {
    setErrorMsg(msg);
  };

  const handleApproved = () => {
    setHitlOpen(false);
    setHitlFields(null);
    setOriginalFields(null);
    // Status will update from SSE (filling → zipping → done)
  };

  /** Handle reject & restart from the HITL modal. */
  const handleReject = () => {
    setHitlOpen(false);
    setHitlFields(null);
    setOriginalFields(null);
    setStatus("failed");
    setErrorMsg("Run cancelled — upload a new title to restart.");
  };

  const isRunInFlight =
    status != null &&
    status !== "done" &&
    status !== "failed";

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-neutral-100">New Title</h1>

      {/* Progress bar */}
      <ProgressBar status={status} />

      {/* Failure banner with transcript link */}
      {errorMsg && (
        <div className="flex items-center justify-between rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-400">
          <span>{errorMsg}</span>
          {runId && status === "failed" && (
            <a
              href={`/api/runs/${runId}/transcript`}
              download
              className="ml-4 whitespace-nowrap rounded border border-red-700 px-2 py-1 text-xs text-red-300 hover:bg-red-900 hover:text-red-100"
            >
              View transcript
            </a>
          )}
        </div>
      )}

      {/* Two-column workspace */}
      <div className="grid flex-1 grid-cols-2 gap-6">
        <UploadCard
          disabled={isRunInFlight}
          uploading={uploading}
          setUploading={setUploading}
          onUploaded={handleUploaded}
          onError={handleUploadError}
        />
        <DownloadCard runId={runId} ready={zipReady} />
      </div>

      {/* HITL Modal */}
      {hitlFields && runId && (
        <HitlModal
          open={hitlOpen}
          runId={runId}
          fields={hitlFields}
          originalFields={originalFields ?? undefined}
          onApproved={handleApproved}
          onReject={handleReject}
          onClose={() => setHitlOpen(false)}
        />
      )}
    </div>
  );
}
