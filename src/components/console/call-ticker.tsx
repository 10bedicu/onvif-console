"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { CallEvent } from "@/lib/types";
import { Activity, ChevronUp } from "lucide-react";

function CallChip({ call }: { call: CallEvent }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px]",
        call.ok
          ? "border-border text-muted-foreground"
          : "border-destructive/40 bg-destructive/10 text-destructive",
        call.kind === "poll" && "opacity-50",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          call.ok ? "bg-success" : "bg-destructive",
        )}
      />
      {call.op}
      <span className="text-placeholder-foreground">
        {call.durationMs.toFixed(0)}ms
      </span>
    </span>
  );
}

export function CallTicker() {
  const { calls, phase } = useStore();
  const [open, setOpen] = useState(false);
  const tickerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const commands = calls.filter((c) => c.kind === "command");
  const shown = open ? commands : commands.slice(-30);

  // keep ticker scrolled to the newest entry
  useEffect(() => {
    const el = open ? listRef.current : tickerRef.current;
    if (el) {
      if (open) el.scrollTop = el.scrollHeight;
      else el.scrollLeft = el.scrollWidth;
    }
  }, [calls.length, open]);

  if (phase !== "connected") return null;

  return (
    <div className="print-hidden fixed inset-x-0 bottom-0 z-40 border-t bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-1.5">
        <button
          className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-soft-foreground"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <Activity className="size-3.5 text-primary" />
          ONVIF calls
          <span className="font-mono text-placeholder-foreground">
            {commands.length}
          </span>
          <ChevronUp
            className={cn("size-3 transition-transform", open && "rotate-180")}
          />
        </button>
        {!open && (
          <div
            ref={tickerRef}
            className="ticker-fade flex flex-1 items-center gap-1.5 overflow-x-hidden"
          >
            {shown.map((c) => (
              <CallChip key={c.id} call={c} />
            ))}
            {commands.length === 0 && (
              <span className="text-[11px] text-placeholder-foreground">
                Commands issued to the camera appear here…
              </span>
            )}
          </div>
        )}
      </div>
      {open && (
        <div
          ref={listRef}
          className="log-stream mx-auto max-h-64 max-w-7xl overflow-y-auto px-4 pb-2"
        >
          <table className="w-full">
            <tbody>
              {commands.map((c) => (
                <tr key={c.id} className="border-t border-soft-border">
                  <td className="py-1 pr-3 text-placeholder-foreground">
                    {new Date(c.ts * 1000).toLocaleTimeString(undefined, {
                      hour12: false,
                    })}
                  </td>
                  <td className="py-1 pr-3 font-medium">{c.op}</td>
                  <td className="max-w-0 truncate py-1 pr-3 text-placeholder-foreground">
                    {c.params}
                  </td>
                  <td className="py-1 pr-3 text-right text-placeholder-foreground">
                    {c.durationMs.toFixed(0)}ms
                  </td>
                  <td
                    className={cn(
                      "py-1 text-right",
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
      )}
    </div>
  );
}
