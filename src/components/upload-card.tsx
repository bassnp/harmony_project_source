"use client";

/**
 * UploadCard — Dashed-rectangle upload icon-button.
 *
 * Click → file dialog → POST /api/runs (multipart/form-data).
 * Greys out & disables while a run is in-flight.
 */

import { useRef } from "react";
import { Upload, Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface UploadCardProps {
  /** Whether a run is currently in-flight (disable uploads). */
  disabled: boolean;
  /** Callback when upload completes successfully — receives the new run ID. */
  onUploaded: (runId: string) => void;
  /** Callback when upload fails. */
  onError: (message: string) => void;
  /** Whether an upload is currently in progress. */
  uploading: boolean;
  /** Set the uploading state. */
  setUploading: (v: boolean) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UploadCard({
  disabled,
  onUploaded,
  onError,
  uploading,
  setUploading,
}: UploadCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    if (disabled || uploading) return;
    inputRef.current?.click();
  };

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);

      const res = await fetch("/api/runs", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Upload failed (${res.status})`);
      }
      const data = (await res.json()) as { id: string };
      onUploaded(data.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      // Reset input so the same file can be re-selected
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const isDisabled = disabled || uploading;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isDisabled}
      className={`flex h-48 w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors ${
        isDisabled
          ? "cursor-not-allowed border-neutral-700 bg-neutral-900 text-neutral-600"
          : "border-neutral-600 bg-neutral-900 text-neutral-400 hover:border-neutral-400 hover:text-neutral-200"
      }`}
    >
      {uploading ? (
        <Loader2 className="h-10 w-10 animate-spin" />
      ) : (
        <Upload className="h-10 w-10" />
      )}
      <span className="text-sm font-medium">
        {uploading ? "Uploading…" : "Upload Title PDF"}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        onChange={handleChange}
        className="hidden"
        aria-label="Upload title PDF"
      />
    </button>
  );
}
