"use client";

import Link from "next/link";
import { useStore } from "@/lib/store";
import { TestCard } from "./test-card";
import { Button } from "@/components/ui/button";
import { FileText, ListChecks, Play, Square } from "lucide-react";

export function TestRunner() {
  const store = useStore();
  const summary = { passed: 0, failed: 0, skipped: 0, error: 0, pending: 0 };
  for (const t of store.tests) {
    const s = store.results[t.id]?.status ?? "pending";
    if (s === "running" || s === "pending") summary.pending += 1;
    else summary[s as keyof typeof summary] += 1;
  }
  const anyFinished =
    summary.passed + summary.failed + summary.skipped + summary.error > 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto flex items-center gap-2 text-sm font-semibold">
          <ListChecks className="size-4 text-primary" />
          Workflow tests
          <span className="font-mono text-xs font-normal text-placeholder-foreground">
            {summary.passed}✓ {summary.failed + summary.error}✗ {summary.skipped}–
          </span>
        </h2>
        {anyFinished && !store.running && (
          <Button variant="outline" size="sm" asChild>
            <Link href="/report">
              <FileText data-icon="inline-start" />
              View report
            </Link>
          </Button>
        )}
        {store.running ? (
          <Button variant="destructive" size="sm" onClick={() => store.cancel()}>
            <Square data-icon="inline-start" />
            Cancel run
          </Button>
        ) : (
          <Button size="sm" onClick={() => store.runAll()}>
            <Play data-icon="inline-start" />
            Run all tests
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {store.tests.map((t) => (
          <TestCard key={t.id} test={t} />
        ))}
      </div>
    </section>
  );
}
