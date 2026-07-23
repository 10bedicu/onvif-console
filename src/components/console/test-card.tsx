"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { TestMeta } from "@/lib/types";
import { StatusBadge } from "./status-badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, Play, RotateCcw } from "lucide-react";

function LogLine({ level, msg, ts }: { level: string; msg: string; ts: number }) {
  const time = new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour12: false,
  });
  return (
    <div className="flex gap-2 whitespace-pre-wrap break-words">
      <span className="shrink-0 text-placeholder-foreground">{time}</span>
      <span
        className={cn(
          level === "success" && "text-success",
          level === "error" && "text-destructive",
          level === "warn" && "text-warning",
          level === "note" && "text-soft-foreground",
          level === "info" && "text-muted-foreground",
        )}
      >
        {msg}
      </span>
    </div>
  );
}

export function TestCard({ test }: { test: TestMeta }) {
  const store = useStore();
  const result = store.results[test.id];
  const progress = store.progress[test.id] ?? 0;
  const status = result?.status ?? "pending";
  const live = store.liveLogs[test.id] ?? [];
  // While running we render streamed logs; after completion the final result
  // carries the authoritative log list.
  const logs = status === "running" ? live : result?.logs?.length ? result.logs : live;

  const [open, setOpen] = useState(false);
  const wasRunning = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  const warnings = result?.warnings ?? [];

  // Auto-expand while running; collapse a clean pass, but keep open when the
  // pass carried warnings (or on failure) so the caveat stays visible.
  useEffect(() => {
    if (status === "running" && !wasRunning.current) setOpen(true);
    if (wasRunning.current && status === "passed" && warnings.length === 0) {
      setOpen(false);
    }
    wasRunning.current = status === "running";
  }, [status, warnings.length]);

  // Follow the log tail.
  useEffect(() => {
    if (open && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs.length, open]);

  const runnable = store.phase === "connected" && !store.running;

  return (
    <div
      className={cn(
        "rounded-squircle-xl rounded-xl border bg-card transition-colors",
        status === "running" && "border-primary/40",
        status === "failed" && "border-destructive/40",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-placeholder-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{test.name}</span>
              <StatusBadge status={status} warnings={warnings.length} />
              {result?.durationMs != null && status !== "running" && (
                <span className="font-mono text-[11px] text-placeholder-foreground">
                  {(result.durationMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
            <p className="truncate text-xs text-soft-foreground">
              {status === "skipped" && result?.detail
                ? `Skipped — ${result.detail}`
                : test.description}
            </p>
          </div>
        </button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={`Run ${test.name}`}
          disabled={!runnable}
          onClick={() => store.runOne(test.id)}
        >
          {status === "pending" ? <Play /> : <RotateCcw />}
        </Button>
      </div>

      {/* progress bar */}
      <div
        className={cn(
          "h-0.5 w-full overflow-hidden",
          status === "running" ? "bg-muted" : "bg-transparent",
        )}
      >
        <div
          className={cn(
            "h-full transition-all duration-500",
            status === "running" && "bg-primary",
            status === "passed" && "bg-success/60",
            status === "failed" && "bg-destructive/60",
          )}
          style={{ width: `${status === "pending" ? 0 : progress}%` }}
        />
      </div>

      {open && (
        <div className="border-t border-soft-border px-4 py-3">
          {result && result.checks.length > 0 && (
            <div className="mb-3 flex flex-col gap-1">
              {result.checks.map((c, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span
                    className={cn(
                      "mt-px font-mono",
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
                </div>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="mb-3 flex flex-col gap-1 rounded-squircle-md rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className="mt-px text-warning">✱</span>
                  <span className="font-medium text-warning">{w.name}</span>
                  {w.detail && (
                    <span className="text-soft-foreground">{w.detail}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div
            ref={logRef}
            className="log-stream max-h-52 overflow-y-auto rounded-squircle-md rounded-md bg-soft-background p-3 dark:bg-neutral-950/60"
          >
            {logs.length === 0 ? (
              <span className="text-placeholder-foreground">
                No logs yet — run this test.
              </span>
            ) : (
              logs.map((l, i) => <LogLine key={i} {...l} />)
            )}
            {status === "running" && (
              <span className="status-pulse text-primary">▍</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
