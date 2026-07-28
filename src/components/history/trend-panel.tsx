"use client";

import Link from "next/link";
import type { TrendResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

// Cell colour per test status.
const CELL: Record<string, string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  error: "bg-destructive",
  skipped: "bg-muted-foreground/40",
  running: "bg-warning",
  pending: "bg-border",
};

function runPassed(summary: Record<string, number>) {
  return (summary.failed ?? 0) + (summary.error ?? 0) === 0;
}

export function TrendPanel({ trend }: { trend: TrendResponse }) {
  // API returns newest-first; render chronologically (oldest → newest).
  const runs = [...trend.runs].reverse();
  if (runs.length < 2) return null; // a trend needs at least two runs

  const passCount = runs.filter((r) => runPassed(r.summary)).length;
  const rate = Math.round((passCount / runs.length) * 100);

  return (
    <div className="mb-4 rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Trend</h2>
        <span className="font-mono text-xs text-soft-foreground">
          {passCount}/{runs.length} runs passed · {rate}%
        </span>
      </div>

      {/* Per-test matrix: rows = tests, columns = runs (oldest → newest) */}
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-y-1 text-xs">
          <tbody>
            {trend.tests.map((t) => (
              <tr key={t.id}>
                <td className="pr-3 whitespace-nowrap text-soft-foreground">
                  {t.name}
                </td>
                {runs.map((r) => {
                  const status = r.tests[t.id] ?? "pending";
                  return (
                    <td key={r.run_id} className="px-0.5">
                      <Link
                        href={`/report?run=${r.run_id}`}
                        title={`${t.name} — ${status}\n${new Date(
                          r.finished_at * 1000,
                        ).toLocaleString()}`}
                        className={cn(
                          "block size-4 rounded-[4px] transition-transform hover:scale-125",
                          CELL[status] ?? CELL.pending,
                        )}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
            {/* footer row: overall run result */}
            <tr>
              <td className="pt-1 pr-3 text-right font-medium text-placeholder-foreground">
                run
              </td>
              {runs.map((r) => (
                <td key={r.run_id} className="px-0.5 pt-1">
                  <div
                    className={cn(
                      "mx-auto h-1 w-4 rounded-full",
                      runPassed(r.summary) ? "bg-success" : "bg-destructive",
                    )}
                  />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-placeholder-foreground">
        <Legend className="bg-success" label="passed" />
        <Legend className="bg-destructive" label="failed / error" />
        <Legend className="bg-muted-foreground/40" label="skipped" />
        <Legend className="bg-border" label="not run" />
        <span className="ml-auto">oldest → newest · click a cell to open its report</span>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("size-2.5 rounded-[3px]", className)} />
      {label}
    </span>
  );
}
