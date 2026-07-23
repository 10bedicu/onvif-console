"use client";

import { cn } from "@/lib/utils";
import type { TestStatus } from "@/lib/types";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Loader2,
  MinusCircle,
  TriangleAlert,
} from "lucide-react";

const config: Record<
  TestStatus,
  { label: string; className: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  pending: {
    label: "Pending",
    className: "bg-muted text-soft-foreground",
    Icon: CircleDashed,
  },
  running: {
    label: "Running",
    className: "bg-primary/10 text-primary status-pulse",
    Icon: Loader2,
  },
  passed: {
    label: "Passed",
    className: "bg-success/10 text-success",
    Icon: CircleCheck,
  },
  failed: {
    label: "Failed",
    className: "bg-destructive/10 text-destructive",
    Icon: CircleX,
  },
  skipped: {
    label: "Skipped",
    className: "bg-warning/10 text-warning",
    Icon: MinusCircle,
  },
  error: {
    label: "Error",
    className: "bg-destructive/10 text-destructive",
    Icon: TriangleAlert,
  },
};

export function StatusBadge({
  status,
  className,
}: {
  status: TestStatus;
  className?: string;
}) {
  const c = config[status] ?? config.pending;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-4xl rounded-squircle-full px-2 text-xs font-medium",
        c.className,
        className,
      )}
    >
      <c.Icon
        className={cn("size-3", status === "running" && "animate-spin")}
      />
      {c.label}
    </span>
  );
}
