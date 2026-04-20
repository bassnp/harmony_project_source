/**
 * /history — Run history listing page.
 *
 * Displays a HistoryTable component with all completed/failed runs.
 */

import { HistoryTable } from "@/components/history-table";

export default function HistoryPage() {
  return (
    <div className="flex h-full flex-col p-6">
      <HistoryTable />
    </div>
  );
}
