"use client";

import type { Report } from "@/lib/types";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/console/status-badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download, Printer, ScanEye } from "lucide-react";
import Link from "next/link";

function fmtTime(ts: number | null | undefined) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function downloadJson(report: Report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const host = report.connection?.host?.replace(/[^\w.-]/g, "_") ?? "camera";
  a.href = url;
  a.download = `onvif-report-${host}-${report.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportView({ report }: { report: Report }) {
  const conn = report.connection;
  const total = report.results.length;
  const s = report.summary;
  const verdictPass = (s.failed ?? 0) + (s.error ?? 0) === 0;
  const testName = (id: string) =>
    report.tests.find((t) => t.id === id)?.name ?? id;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 print:max-w-none print:px-0">
      {/* toolbar */}
      <div className="print-hidden mb-6 flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/">
            <ArrowLeft data-icon="inline-start" />
            Console
          </Link>
        </Button>
        <span className="mr-auto" />
        <Button variant="outline" size="sm" onClick={() => downloadJson(report)}>
          <Download data-icon="inline-start" />
          Export JSON
        </Button>
        <Button size="sm" onClick={() => window.print()}>
          <Printer data-icon="inline-start" />
          Print
        </Button>
      </div>

      {/* header */}
      <header className="mb-8">
        <div className="mb-1 flex items-center gap-2 text-primary">
          <ScanEye className="size-5" />
          <span className="text-xs font-semibold uppercase tracking-widest">
            ONVIF Conformance Test Report
          </span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {conn?.device.manufacturer} {conn?.device.model}
        </h1>
        <p className="mt-1 font-mono text-xs text-soft-foreground">
          {conn?.host}:{conn?.port} · firmware {conn?.device.firmware} · serial{" "}
          {conn?.device.serial} · run {report.id} · {fmtTime(report.startedAt)}
        </p>
      </header>

      {/* verdict + summary */}
      <section className="print-avoid-break mb-8 grid grid-cols-2 gap-3 sm:grid-cols-6">
        <div
          className={cn(
            "col-span-2 flex flex-col justify-center rounded-squircle-xl rounded-xl border p-4",
            verdictPass
              ? "border-success/30 bg-success/5"
              : "border-destructive/30 bg-destructive/5",
          )}
        >
          <span
            className={cn(
              "text-2xl font-bold",
              verdictPass ? "text-success" : "text-destructive",
            )}
          >
            {verdictPass ? "PASS" : "FAIL"}
          </span>
          <span className="text-xs text-soft-foreground">
            {total} workflow test{total === 1 ? "" : "s"}
          </span>
        </div>
        {(
          [
            ["Passed", s.passed ?? 0, "text-success"],
            ["Failed", s.failed ?? 0, "text-destructive"],
            ["Errors", s.error ?? 0, "text-destructive"],
            ["Skipped", s.skipped ?? 0, "text-warning"],
          ] as const
        ).map(([label, n, color]) => (
          <div
            key={label}
            className="flex flex-col justify-center rounded-squircle-xl rounded-xl border p-4"
          >
            <span className={cn("text-2xl font-bold", n > 0 ? color : "")}>
              {n}
            </span>
            <span className="text-xs text-soft-foreground">{label}</span>
          </div>
        ))}
      </section>

      {/* capabilities */}
      {conn && (
        <section className="print-avoid-break mb-8">
          <h2 className="mb-2 text-sm font-semibold">Discovered capabilities</h2>
          <div className="overflow-hidden rounded-squircle-xl rounded-xl border">
            <table className="w-full text-xs">
              <tbody>
                {(
                  [
                    ["Absolute pan/tilt", conn.capabilities.absolutePanTilt],
                    ["Relative pan/tilt", conn.capabilities.relativePanTilt],
                    ["Continuous pan/tilt", conn.capabilities.continuousPanTilt],
                    ["Absolute zoom", conn.capabilities.absoluteZoom],
                    ["Home position", conn.capabilities.homeSupported],
                    ["Max presets", conn.capabilities.maxPresets],
                  ] as const
                ).map(([label, val]) => (
                  <tr key={label} className="border-b border-soft-border last:border-0">
                    <td className="px-3 py-1.5 font-medium">{label}</td>
                    <td className="px-3 py-1.5 font-mono text-soft-foreground">
                      {typeof val === "boolean" ? (val ? "yes" : "no") : String(val)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* per-test detail */}
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold">Test results</h2>
        <div className="flex flex-col gap-3">
          {report.results.map((r) => (
            <div
              key={r.id}
              className="print-avoid-break overflow-hidden rounded-squircle-xl rounded-xl border"
            >
              <div className="flex items-center gap-2 bg-soft-background px-3 py-2 dark:bg-neutral-900/60">
                <span className="text-sm font-medium">{testName(r.id)}</span>
                <StatusBadge status={r.status} />
                {r.durationMs != null && (
                  <span className="font-mono text-[11px] text-placeholder-foreground">
                    {(r.durationMs / 1000).toFixed(1)}s
                  </span>
                )}
                {r.detail && (
                  <span className="truncate text-xs text-soft-foreground">
                    {r.detail}
                  </span>
                )}
              </div>
              {r.checks.length > 0 && (
                <ul className="flex flex-col gap-1 px-3 py-2">
                  {r.checks.map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span
                        className={cn(
                          "font-mono",
                          c.passed ? "text-success" : "text-destructive",
                        )}
                      >
                        {c.passed ? "✓" : "✗"}
                      </span>
                      <span className="font-medium">{c.name}</span>
                      {c.detail && (
                        <span className="font-mono text-placeholder-foreground">
                          {c.detail}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {r.logs.length > 0 && (
                <details className="print-hidden border-t border-soft-border">
                  <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-placeholder-foreground">
                    {r.logs.length} log line{r.logs.length === 1 ? "" : "s"}
                  </summary>
                  <div className="log-stream max-h-56 overflow-y-auto px-3 pb-2">
                    {r.logs.map((l, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="shrink-0 text-placeholder-foreground">
                          {new Date(l.ts * 1000).toLocaleTimeString(undefined, {
                            hour12: false,
                          })}
                        </span>
                        <span
                          className={cn(
                            "whitespace-pre-wrap break-words",
                            l.level === "success" && "text-success",
                            l.level === "error" && "text-destructive",
                            l.level === "note" && "text-warning",
                          )}
                        >
                          {l.msg}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* call log */}
      <section className="print-break-before">
        <h2 className="mb-2 text-sm font-semibold">
          ONVIF command log{" "}
          <span className="font-mono text-xs font-normal text-placeholder-foreground">
            ({report.calls.filter((c) => c.kind === "command").length} commands)
          </span>
        </h2>
        <div className="overflow-hidden rounded-squircle-xl rounded-xl border">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-soft-background text-left dark:bg-neutral-900/60">
                <th className="px-3 py-1.5 font-semibold">Time</th>
                <th className="px-3 py-1.5 font-semibold">Operation</th>
                <th className="px-3 py-1.5 font-semibold">Parameters</th>
                <th className="px-3 py-1.5 text-right font-semibold">Duration</th>
                <th className="px-3 py-1.5 text-right font-semibold">Result</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {report.calls
                .filter((c) => c.kind === "command")
                .map((c) => (
                  <tr key={c.id} className="border-t border-soft-border">
                    <td className="px-3 py-1 text-placeholder-foreground">
                      {new Date(c.ts * 1000).toLocaleTimeString(undefined, {
                        hour12: false,
                      })}
                    </td>
                    <td className="px-3 py-1">{c.op}</td>
                    <td className="max-w-0 truncate px-3 py-1 text-placeholder-foreground">
                      {c.params}
                    </td>
                    <td className="px-3 py-1 text-right text-placeholder-foreground">
                      {c.durationMs.toFixed(0)}ms
                    </td>
                    <td
                      className={cn(
                        "px-3 py-1 text-right",
                        c.ok ? "text-success" : "text-destructive",
                      )}
                    >
                      {c.ok ? "OK" : c.error ?? "FAULT"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-10 border-t pt-4 text-center text-[10px] text-placeholder-foreground">
        Generated by ONVIF Camera Testing Console · {fmtTime(report.finishedAt)}
      </footer>
    </div>
  );
}
