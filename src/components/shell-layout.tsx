"use client";

/**
 * ShellLayout — 3-column grid: NavBar | content | ThoughtPanel.
 *
 * Client component wrapping the shell's interactive pieces.
 * Reads `runId` from localStorage for the ThoughtPanel subscription.
 */

import { useState, useEffect } from "react";
import { NavBar } from "@/components/nav-bar";
import { ThoughtPanel } from "@/components/thought-panel";

const LS_KEY = "hcd_current_run_id";

export function ShellLayout({ children }: { children: React.ReactNode }) {
  const [runId, setRunId] = useState<string | null>(null);

  // Listen for localStorage changes (set by new/page.tsx on upload)
  useEffect(() => {
    const sync = () => {
      setRunId(localStorage.getItem(LS_KEY));
    };
    sync();

    // Custom event dispatched by new/page.tsx when runId changes
    window.addEventListener("storage", sync);
    window.addEventListener("hcd-run-changed", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("hcd-run-changed", sync);
    };
  }, []);

  return (
    <div className="grid h-full grid-cols-[14rem_1fr_36rem]">
      <NavBar />
      <main className="h-full overflow-y-auto">{children}</main>
      <ThoughtPanel runId={runId} />
    </div>
  );
}
