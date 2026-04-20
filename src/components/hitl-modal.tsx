"use client";

/**
 * HitlModal — Human-in-the-loop approval modal.
 *
 * Displays extracted fields in an editable form.
 * "Approve" submits the (possibly edited) fields to POST /api/runs/:id/approve.
 * Uses Radix Dialog for accessible modal behavior.
 */

import { useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle, Plus, Trash2, XCircle } from "lucide-react";

// ---------------------------------------------------------------------------
// Types — mirrors ExtractedFields from extractedSchema.ts (client-side)
// ---------------------------------------------------------------------------

interface Owner {
  name: string;
  mailing_address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  email?: string;
}

interface ExtractedFields {
  decal_number: string;
  serial_number: string;
  trade_name?: string;
  manufacturer_name?: string;
  manufacture_date?: string;
  model_name?: string;
  owners: Owner[];
  situs_address?: string;
  situs_city?: string;
  situs_state?: string;
  situs_zip?: string;
  sale_price?: string;
  sale_date?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface HitlModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /** Run ID for the approval POST. */
  runId: string;
  /** Extracted fields to review/edit. */
  fields: ExtractedFields;
  /** Original OCR-extracted fields for diff highlighting (before user edits). */
  originalFields?: ExtractedFields;
  /** Called after successful approval. */
  onApproved: () => void;
  /** Called when user rejects and restarts (cancel the run). */
  onReject?: () => void;
  /** Called on close without approval. */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Scalar field metadata for rendering
// ---------------------------------------------------------------------------

const SCALAR_FIELDS: { key: keyof Omit<ExtractedFields, "owners">; label: string }[] = [
  { key: "decal_number", label: "Decal Number" },
  { key: "serial_number", label: "Serial Number" },
  { key: "trade_name", label: "Trade Name" },
  { key: "manufacturer_name", label: "Manufacturer" },
  { key: "manufacture_date", label: "Manufacture Date" },
  { key: "model_name", label: "Model" },
  { key: "situs_address", label: "Situs Address" },
  { key: "situs_city", label: "Situs City" },
  { key: "situs_state", label: "Situs State" },
  { key: "situs_zip", label: "Situs ZIP" },
  { key: "sale_price", label: "Sale Price" },
  { key: "sale_date", label: "Sale Date" },
  { key: "notes", label: "Notes" },
];

const OWNER_FIELDS: { key: keyof Owner; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "mailing_address", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HitlModal({
  open,
  runId,
  fields,
  originalFields,
  onApproved,
  onReject,
  onClose,
}: HitlModalProps) {
  const [draft, setDraft] = useState<ExtractedFields>(fields);
  const [submitting, setSubmitting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Check if a scalar field has been modified from the original OCR value. */
  const isScalarDirty = (key: keyof Omit<ExtractedFields, "owners">): boolean => {
    if (!originalFields) return false;
    return (draft[key] ?? "") !== (originalFields[key] ?? "");
  };

  /** Check if an owner field has been modified from the original OCR value. */
  const isOwnerFieldDirty = (ownerIndex: number, key: keyof Owner): boolean => {
    if (!originalFields) return false;
    const orig = originalFields.owners[ownerIndex];
    if (!orig) return true; // new owner — always dirty
    return (draft.owners[ownerIndex]?.[key] ?? "") !== (orig[key] ?? "");
  };

  /** Update a scalar field in the draft. */
  const setField = useCallback(
    (key: keyof Omit<ExtractedFields, "owners">, value: string) => {
      setDraft((prev) => ({ ...prev, [key]: value || undefined }));
    },
    [],
  );

  /** Update an owner field in the draft. */
  const setOwnerField = useCallback(
    (index: number, key: keyof Owner, value: string) => {
      setDraft((prev) => {
        const owners = [...prev.owners];
        const owner = { ...owners[index]! };
        if (key === "name") {
          owner[key] = value;
        } else {
          (owner as Record<string, string | undefined>)[key] = value || undefined;
        }
        owners[index] = owner;
        return { ...prev, owners };
      });
    },
    [],
  );

  /** Add a new empty owner. */
  const addOwner = useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      owners: [...prev.owners, { name: "" }],
    }));
  }, []);

  /** Remove an owner by index. */
  const removeOwner = useCallback((index: number) => {
    setDraft((prev) => ({
      ...prev,
      owners: prev.owners.filter((_, i) => i !== index),
    }));
  }, []);

  /** Submit approval. */
  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Approval failed (${res.status})`);
      }
      onApproved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval failed");
    } finally {
      setSubmitting(false);
    }
  };

  /** Reject and restart — cancel the current run. */
  const handleReject = async () => {
    setRejecting(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/cancel`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Cancel failed (${res.status})`);
      }
      onReject?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setRejecting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-6 shadow-xl">
          <Dialog.Title className="mb-4 text-lg font-semibold text-neutral-100">
            Review Extracted Fields
          </Dialog.Title>
          <Dialog.Description className="mb-6 text-sm text-neutral-400">
            Verify and edit the fields extracted from the title PDF before filling the HCD forms.
          </Dialog.Description>

          {/* Scalar fields */}
          <div className="grid grid-cols-2 gap-3">
            {SCALAR_FIELDS.map(({ key, label }) => {
              const dirty = isScalarDirty(key);
              return (
                <label key={key} className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-neutral-400">
                    {label}
                    {dirty && <span className="ml-1 text-yellow-400" title="Modified">(edited)</span>}
                  </span>
                  <input
                    type="text"
                    value={(draft[key] as string) ?? ""}
                    onChange={(e) => setField(key, e.target.value)}
                    className={`rounded border px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-500 ${
                      dirty
                        ? "border-yellow-600 bg-yellow-950/30"
                        : "border-neutral-700 bg-neutral-800"
                    }`}
                  />
                </label>
              );
            })}
          </div>

          {/* Owners */}
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-neutral-300">Owners</h4>
              <button
                type="button"
                onClick={addOwner}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            {draft.owners.map((owner, oi) => (
              <div
                key={oi}
                className="mb-3 rounded border border-neutral-800 bg-neutral-850 p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-neutral-400">
                    Owner {oi + 1}
                  </span>
                  {draft.owners.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeOwner(oi)}
                      className="text-red-500 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {OWNER_FIELDS.map(({ key, label }) => {
                    const dirty = isOwnerFieldDirty(oi, key);
                    return (
                      <label key={key} className="flex flex-col gap-0.5">
                        <span className="text-xs text-neutral-500">
                          {label}
                          {dirty && <span className="ml-1 text-yellow-400" title="Modified">(edited)</span>}
                        </span>
                        <input
                          type="text"
                          value={(owner[key] as string) ?? ""}
                          onChange={(e) => setOwnerField(oi, key, e.target.value)}
                          className={`rounded border px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-500 ${
                            dirty
                              ? "border-yellow-600 bg-yellow-950/30"
                              : "border-neutral-700 bg-neutral-800"
                          }`}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Error */}
          {error && (
            <p className="mt-3 text-sm text-red-400">{error}</p>
          )}

          {/* Actions */}
          <div className="mt-6 flex items-center justify-between">
            <button
              type="button"
              onClick={() => void handleReject()}
              disabled={rejecting || submitting}
              className="flex items-center gap-2 rounded bg-red-800 px-4 py-2 text-sm font-medium text-red-100 hover:bg-red-700 disabled:opacity-50"
            >
              <XCircle className="h-4 w-4" />
              {rejecting ? "Cancelling…" : "Reject & Restart"}
            </button>
            <div className="flex gap-3">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded px-4 py-2 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  Close
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => void handleApprove()}
                disabled={submitting || rejecting}
                className="flex items-center gap-2 rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <CheckCircle className="h-4 w-4" />
                {submitting ? "Approving…" : "Approve & Fill"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
