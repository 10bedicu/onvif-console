"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { CameraSummary, RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft, History, Loader2, Trash2, Video } from "lucide-react";

export default function HistoryPage() {
  const [cameras, setCameras] = useState<CameraSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [filter, setFilter] = useState<string | null>(null); // camera_key
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ cameras }, { runs }] = await Promise.all([
        api.historyCameras(),
        api.history(filter ? { cameraKey: filter } : undefined),
      ]);
      setCameras(cameras);
      setRuns(runs);
    } catch {
      setCameras([]);
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (runId: string) => {
    await api.deleteHistoryRun(runId).catch(() => {});
    load();
  };

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

      {/* Camera filter — distinct cameras tested so far */}
      {cameras.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <FilterChip active={filter === null} onClick={() => setFilter(null)}>
            All cameras
          </FilterChip>
          {cameras.map((c) => (
            <FilterChip
              key={c.camera_key}
              active={filter === c.camera_key}
              onClick={() => setFilter(c.camera_key)}
            >
              <Video className="size-3" />
              {c.manufacturer} {c.model}
              <span className="text-placeholder-foreground">
                {c.serial ? `· ${c.serial}` : `· ${c.last_host}`}
              </span>
              <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] font-semibold">
                {c.run_count}
              </span>
            </FilterChip>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center gap-2 text-soft-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading history…
        </div>
      ) : runs.length === 0 ? (
        <p className="py-20 text-center text-sm text-soft-foreground">
          No runs recorded yet. Completed runs are saved automatically per
          camera.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {runs.map((r) => {
            const bad = r.failed + r.error;
            const pass = bad === 0;
            return (
              <div
                key={r.run_id}
                className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3"
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
                  href={`/report?run=${r.run_id}`}
                  className="min-w-0 flex-1 hover:underline"
                >
                  <div className="truncate text-sm font-medium">{r.device}</div>
                  <div className="font-mono text-xs text-soft-foreground">
                    {r.last_host} · {new Date(r.finished_at * 1000).toLocaleString()}
                  </div>
                </Link>
                <span className="shrink-0 font-mono text-xs text-placeholder-foreground">
                  {r.passed}✓ {bad}✗ {r.skipped}–
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Delete run"
                  onClick={() => remove(r.run_id)}
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

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-soft-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
