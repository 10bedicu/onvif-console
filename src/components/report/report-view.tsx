"use client";

import type { Report, TestResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { capabilityList } from "@/lib/capabilities";
import { StatusBadge } from "@/components/console/status-badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  CircleCheck,
  Download,
  MinusCircle,
  Printer,
  ScanEye,
} from "lucide-react";
import Link from "next/link";

function fmtTime(ts: number | null | undefined) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function fmtClock(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour12: false });
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

function TestBlock({
  result,
  name,
}: {
  result: TestResult;
  name: string;
}) {
  const warnings = result.warnings ?? [];
  return (
    <div className="test-block print-avoid-break overflow-hidden rounded-squircle-xl rounded-xl border">
      <div className="test-head flex flex-wrap items-center gap-2 bg-soft-background px-3 py-2 dark:bg-neutral-900/60">
        <span className="test-name text-sm font-semibold">{name}</span>
        <StatusBadge status={result.status} warnings={warnings.length} />
        {result.durationMs != null && (
          <span className="font-mono text-[11px] text-placeholder-foreground">
            {(result.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {result.detail && (
          <span className="text-xs text-soft-foreground">{result.detail}</span>
        )}
      </div>

      {result.checks.length > 0 && (
        <ul className="flex flex-col gap-1 px-3 py-2">
          {result.checks.map((c, i) => (
            <li key={i} className="check-row flex items-start gap-2 text-xs">
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

      {warnings.length > 0 && (
        <div className="warn-box mx-3 mb-2 flex flex-col gap-1 rounded-squircle-md rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="text-warning">✱</span>
              <span className="font-medium text-warning">{w.name}</span>
              {w.detail && (
                <span className="text-soft-foreground">{w.detail}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {result.logs.length > 0 && (
        <>
          {/* screen: collapsible; print: always rendered (see print-logs) */}
          <details className="print-hidden border-t border-soft-border">
            <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-placeholder-foreground">
              {result.logs.length} log line
              {result.logs.length === 1 ? "" : "s"}
            </summary>
            <div className="log-stream max-h-56 overflow-y-auto px-3 pb-2">
              {result.logs.map((l, i) => (
                <LogRow key={i} ts={l.ts} level={l.level} msg={l.msg} />
              ))}
            </div>
          </details>
          <div className="print-logs hidden">
            {result.logs.map((l, i) => (
              <LogRow key={i} ts={l.ts} level={l.level} msg={l.msg} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LogRow({ ts, level, msg }: { ts: number; level: string; msg: string }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-placeholder-foreground">{fmtClock(ts)}</span>
      <span
        className={cn(
          "whitespace-pre-wrap break-words",
          level === "success" && "text-success",
          level === "error" && "text-destructive",
          level === "warn" && "text-warning",
          level === "note" && "text-soft-foreground",
        )}
      >
        {msg}
      </span>
    </div>
  );
}

export function ReportView({ report }: { report: Report }) {
  const conn = report.connection;
  const total = report.results.length;
  const s = report.summary;
  const verdictPass = (s.failed ?? 0) + (s.error ?? 0) === 0;
  const totalWarnings = report.results.reduce(
    (n, r) => n + (r.warnings?.length ?? 0),
    0,
  );
  const testName = (id: string) =>
    report.tests.find((t) => t.id === id)?.name ?? id;

  return (
    <div className="report-doc mx-auto w-full max-w-4xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
      {/* toolbar (screen only) */}
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
          Print / Save PDF
        </Button>
      </div>

      {/* ── Masthead ───────────────────────────────────────────────────── */}
      <header className="report-masthead mb-8 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-primary">
            <ScanEye className="size-5 shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-widest">
              ONVIF PTZ Test Report
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {conn?.device.manufacturer} {conn?.device.model}
          </h1>
          <p className="mt-1 font-mono text-xs text-soft-foreground">
            {conn?.host}:{conn?.port} · firmware {conn?.device.firmware} · serial{" "}
            {conn?.device.serial}
          </p>
        </div>
        <div className="shrink-0 text-right font-mono text-[11px] leading-relaxed text-placeholder-foreground">
          <div>run {report.id}</div>
          <div>{fmtTime(report.startedAt)}</div>
        </div>
      </header>

      {/* ── 1. Summary ─────────────────────────────────────────────────── */}
      <section className="report-section print-avoid-break mb-8">
        <h2 className="section-title mb-2 text-sm font-semibold">Summary</h2>
        <div className="summary-grid grid grid-cols-2 gap-3 sm:grid-cols-6">
          <div
            className={cn(
              "verdict-tile col-span-2 flex flex-col justify-center rounded-squircle-xl rounded-xl border p-4",
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
              {totalWarnings > 0 && ` · ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}`}
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
              className="stat-tile flex flex-col justify-center rounded-squircle-xl rounded-xl border p-4"
            >
              <span className={cn("text-2xl font-bold", n > 0 ? color : "")}>
                {n}
              </span>
              <span className="text-xs text-soft-foreground">{label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── 2. Capabilities (supported + missing) ──────────────────────── */}
      {conn && (
        <section className="report-section print-avoid-break mb-8">
          <h2 className="section-title mb-2 flex items-baseline gap-2 text-sm font-semibold">
            Capabilities
            <span className="font-mono text-xs font-normal text-placeholder-foreground">
              {capabilityList(conn.capabilities).filter((i) => i.on).length}/
              {capabilityList(conn.capabilities).length} supported
            </span>
          </h2>
          <div className="cap-grid grid grid-cols-2 gap-x-6 gap-y-0 overflow-hidden rounded-squircle-xl rounded-xl border sm:grid-cols-2">
            {capabilityList(conn.capabilities).map((cap) => (
              <div
                key={cap.label}
                className="cap-row flex items-center gap-2 border-b border-soft-border px-3 py-1.5 text-xs"
              >
                {cap.on ? (
                  <CircleCheck className="size-3.5 shrink-0 text-success" />
                ) : (
                  <MinusCircle className="size-3.5 shrink-0 text-placeholder-foreground" />
                )}
                <span
                  className={cn(
                    "font-medium",
                    !cap.on && "text-soft-foreground",
                  )}
                >
                  {cap.label}
                </span>
                <span
                  className={cn(
                    "ml-auto font-mono",
                    cap.on ? "text-soft-foreground" : "text-placeholder-foreground",
                  )}
                >
                  {cap.value}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 3. Test results ────────────────────────────────────────────── */}
      <section className="report-section results-section mb-8">
        <h2 className="section-title mb-2 text-sm font-semibold">Test results</h2>
        <div className="flex flex-col gap-3">
          {report.results.map((r) => (
            <TestBlock key={r.id} result={r} name={testName(r.id)} />
          ))}
        </div>
      </section>

      {/* ── ONVIF command log (screen only) ────────────────────────────── */}
      <section className="print-hidden">
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
                      {fmtClock(c.ts)}
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

      <footer className="report-footer mt-10 border-t pt-4 text-center text-[10px] text-placeholder-foreground">
        Generated by ONVIF Camera Testing Console · {fmtTime(report.finishedAt)}
      </footer>
    </div>
  );
}
