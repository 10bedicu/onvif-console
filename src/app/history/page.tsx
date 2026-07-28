"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { CameraSummary, RunSummary, TrendResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TrendPanel } from "@/components/history/trend-panel";
import { ArrowLeft, History, Loader2, Trash2, Video } from "lucide-react";

const PAGE = 25;

export default function HistoryPage() {
  const [cameras, setCameras] = useState<CameraSummary[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [cameraKey, setCameraKey] = useState<string | null>(null);

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [trend, setTrend] = useState<TrendResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // distinct models (with aggregated run counts) derived from the camera list
  const models = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cameras) {
      if (!c.model) continue;
      m.set(c.model, (m.get(c.model) ?? 0) + c.run_count);
    }
    return [...m.entries()].map(([name, runCount]) => ({ name, runCount }));
  }, [cameras]);

  // cameras in the current model scope
  const scopedCameras = useMemo(
    () => (model ? cameras.filter((c) => c.model === model) : cameras),
    [cameras, model],
  );

  const filter = useMemo(
    () => (cameraKey ? { cameraKey } : model ? { model } : {}),
    [cameraKey, model],
  );
  const filterKey = `${model ?? ""}|${cameraKey ?? ""}`;

  useEffect(() => {
    api.historyCameras().then(({ cameras }) => setCameras(cameras)).catch(() => {});
  }, []);

  // (Re)load first page whenever the filter changes.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setRuns([]);
    setOffset(0);
    (async () => {
      try {
        const [{ runs }, trend] = await Promise.all([
          api.history({ ...filter, limit: PAGE, offset: 0 }),
          model || cameraKey
            ? api.historyTrend({ ...filter, limit: 20 })
            : Promise.resolve(null),
        ]);
        if (stale) return;
        setRuns(runs);
        setHasMore(runs.length === PAGE);
        setOffset(runs.length);
        setTrend(trend);
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const { runs: more } = await api.history({ ...filter, limit: PAGE, offset });
      setRuns((prev) => [...prev, ...more]);
      setHasMore(more.length === PAGE);
      setOffset((o) => o + more.length);
    } finally {
      setLoadingMore(false);
    }
  }, [filter, offset]);

  const remove = async (runId: string) => {
    await api.deleteHistoryRun(runId).catch(() => {});
    setRuns((prev) => prev.filter((r) => r.run_id !== runId));
    api.historyCameras().then(({ cameras }) => setCameras(cameras)).catch(() => {});
    if (model || cameraKey)
      api.historyTrend({ ...filter, limit: 20 }).then(setTrend).catch(() => {});
  };

  const pickModel = (m: string | null) => {
    setModel(m);
    setCameraKey(null);
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

      {/* Model filter (distinct models tested so far) */}
      {models.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium tracking-wide text-placeholder-foreground uppercase">
            Model
          </span>
          <FilterChip active={model === null} onClick={() => pickModel(null)}>
            All models
          </FilterChip>
          {models.map((m) => (
            <FilterChip
              key={m.name}
              active={model === m.name}
              onClick={() => pickModel(m.name)}
            >
              {m.name}
              <Count>{m.runCount}</Count>
            </FilterChip>
          ))}
        </div>
      )}

      {/* Camera filter (individual units, scoped to the selected model) */}
      {scopedCameras.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium tracking-wide text-placeholder-foreground uppercase">
            Camera
          </span>
          <FilterChip active={cameraKey === null} onClick={() => setCameraKey(null)}>
            All{model ? ` ${model}` : ""}
          </FilterChip>
          {scopedCameras.map((c) => (
            <FilterChip
              key={c.camera_key}
              active={cameraKey === c.camera_key}
              onClick={() => setCameraKey(c.camera_key)}
            >
              <Video className="size-3" />
              {model ? "" : `${c.model} · `}
              {c.serial ?? c.last_host}
              <Count>{c.run_count}</Count>
            </FilterChip>
          ))}
        </div>
      )}

      {trend && <TrendPanel trend={trend} />}

      {loading ? (
        <div className="flex min-h-[30vh] items-center justify-center gap-2 text-soft-foreground">
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
                    {r.last_host} ·{" "}
                    {new Date(r.finished_at * 1000).toLocaleString()}
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

          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 self-center"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore && <Loader2 className="size-3 animate-spin" data-icon="inline-start" />}
              Load more
            </Button>
          )}
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

function Count({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
      {children}
    </span>
  );
}
