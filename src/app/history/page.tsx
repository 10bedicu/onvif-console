"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { deleteRun, loadHistory, type HistoryEntry } from "@/lib/history";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft, History, Trash2 } from "lucide-react";

export default function HistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => setEntries(loadHistory()), []);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <div className="mb-6 flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/">
            <ArrowLeft data-icon="inline-start" />
            Console
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-sm font-semibold">
          <History className="size-4 text-primary" />
          Run history
        </h1>
      </div>

      {entries.length === 0 ? (
        <p className="py-20 text-center text-sm text-soft-foreground">
          No runs recorded yet. Completed runs are saved automatically per
          camera.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((e) => {
            const pass = (e.summary.failed ?? 0) + (e.summary.error ?? 0) === 0;
            return (
              <div
                key={e.runId}
                className="flex items-center gap-3 rounded-squircle-xl rounded-xl border bg-card px-4 py-3"
              >
                <span
                  className={cn(
                    "w-12 shrink-0 text-sm font-bold",
                    pass ? "text-success" : "text-destructive",
                  )}
                >
                  {pass ? "PASS" : "FAIL"}
                </span>
                <Link
                  href={`/report?run=${e.runId}`}
                  className="min-w-0 flex-1 hover:underline"
                >
                  <div className="truncate text-sm font-medium">{e.device}</div>
                  <div className="font-mono text-xs text-soft-foreground">
                    {e.host} · fw {e.firmware} ·{" "}
                    {new Date(e.finishedAt * 1000).toLocaleString()}
                  </div>
                </Link>
                <span className="shrink-0 font-mono text-xs text-placeholder-foreground">
                  {e.summary.passed ?? 0}✓ {(e.summary.failed ?? 0) + (e.summary.error ?? 0)}✗{" "}
                  {e.summary.skipped ?? 0}–
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Delete run"
                  onClick={() => {
                    deleteRun(e.runId);
                    setEntries(loadHistory());
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
