"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Report } from "@/lib/types";
import { ReportView } from "@/components/report/report-view";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FileQuestion, Loader2 } from "lucide-react";

function ReportLoader() {
  const params = useSearchParams();
  const runId = params.get("run");
  const [report, setReport] = useState<Report | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");

  useEffect(() => {
    // A specific run id loads from persisted history; otherwise show the
    // current in-memory run.
    const load = runId ? api.historyRun(runId) : api.report();
    load
      .then((r) => {
        setReport(r as Report);
        setState("ready");
      })
      .catch(() => setState("missing"));
  }, [runId]);

  if (state === "loading") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center gap-2 text-soft-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading report…
      </div>
    );
  }
  if (state === "missing" || !report) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-soft-foreground">
        <FileQuestion className="size-8" />
        <p className="text-sm">No report available — run some tests first.</p>
        <Button variant="outline" size="sm" asChild>
          <Link href="/">
            <ArrowLeft data-icon="inline-start" />
            Back to console
          </Link>
        </Button>
      </div>
    );
  }
  return <ReportView report={report} />;
}

export default function ReportPage() {
  return (
    <Suspense>
      <ReportLoader />
    </Suspense>
  );
}
