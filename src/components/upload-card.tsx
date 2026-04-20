"use client";

/**
 * UploadCard — Dashed-rectangle upload icon-button with drag-and-drop.
 *
 * Click → file dialog → POST /api/runs (multipart/form-data).
 * Drag a PDF onto the card → same upload flow.
 * Non-PDF drops are rejected client-side with a user-visible error.
 * Greys out & disables while a run is in-flight.
 */

import { useRef, useState } from "react";
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the file looks like a PDF based on either MIME type
 * (`application/pdf`, `application/x-pdf`) or a `.pdf` extension. The server
 * still validates magic bytes — this client check is purely UX guard-rail
 * to reject obvious mismatches before issuing a wasted POST.
 */
function isPdfFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (mime === "application/pdf" || mime === "application/x-pdf") return true;
  return file.name.toLowerCase().endsWith(".pdf");
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
  const [dragActive, setDragActive] = useState(false);
  const [dragInvalid, setDragInvalid] = useState(false);

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

  // -------------------------------------------------------------------------
  // Drag-and-drop handlers
  // -------------------------------------------------------------------------

  // Inspect the dragged payload (without reading file contents) to decide
  // whether to show the "valid drop" or "invalid drop" cursor. During
  // dragenter/dragover the browser only exposes `DataTransferItem.type` and
  // `DataTransferItem.kind` — actual `File` objects are not yet available.
  const previewDragValidity = (e: React.DragEvent<HTMLDivElement>): boolean => {
    const items = e.dataTransfer?.items;
    if (!items || items.length === 0) return false;
    // Reject multi-file drops up front (we only accept one PDF per run).
    if (items.length > 1) return false;
    const item = items[0];
    if (!item || item.kind !== "file") return false;
    const type = item.type.toLowerCase();
    // Accept explicit PDF MIME types. Empty/unknown MIME is allowed here
    // because some browsers omit it on dragover; we re-validate on drop.
    if (type === "application/pdf" || type === "application/x-pdf") return true;
    if (type === "") return true;
    return false;
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (isDisabled) return;
    const valid = previewDragValidity(e);
    setDragActive(true);
    setDragInvalid(!valid);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    // Must preventDefault on dragover to permit a drop.
    e.preventDefault();
    e.stopPropagation();
    if (isDisabled) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    const valid = previewDragValidity(e);
    e.dataTransfer.dropEffect = valid ? "copy" : "none";
    if (!dragActive) setDragActive(true);
    if (dragInvalid !== !valid) setDragInvalid(!valid);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Only clear when leaving the card itself, not when crossing into a child.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
    setDragInvalid(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    setDragInvalid(false);
    if (isDisabled) return;

    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) {
      onError("No file detected in the drop. Please try again.");
      return;
    }
    if (files.length > 1) {
      onError("Only one PDF can be uploaded at a time.");
      return;
    }
    const file = files[0]!;
    if (!isPdfFile(file)) {
      onError(
        `"${file.name}" is not a PDF. Only PDF files are accepted.`,
      );
      return;
    }
    void handleFile(file);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isDisabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const borderClass = isDisabled
    ? "cursor-not-allowed border-neutral-700 bg-neutral-900 text-neutral-600"
    : dragActive
      ? dragInvalid
        ? "cursor-not-allowed border-red-500 bg-red-950/30 text-red-300"
        : "cursor-copy border-emerald-400 bg-emerald-950/30 text-emerald-200"
      : "cursor-pointer border-neutral-600 bg-neutral-900 text-neutral-400 hover:border-neutral-400 hover:text-neutral-200";

  return (
    <div
      role="button"
      tabIndex={isDisabled ? -1 : 0}
      aria-disabled={isDisabled}
      aria-label="Upload title PDF (click or drag and drop)"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex h-48 w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${borderClass}`}
    >
      {uploading ? (
        <Loader2 className="h-10 w-10 animate-spin" />
      ) : (
        <Upload className="h-10 w-10 pointer-events-none" />
      )}
      <span className="text-sm font-medium pointer-events-none">
        {uploading
          ? "Uploading…"
          : dragActive
            ? dragInvalid
              ? "PDF files only"
              : "Drop to upload"
            : "Upload Title PDF"}
      </span>
      {!uploading && !dragActive && (
        <span className="text-xs text-neutral-500 pointer-events-none">
          Click or drag a PDF here
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        onChange={handleChange}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}

