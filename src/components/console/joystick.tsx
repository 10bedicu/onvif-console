"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Gamepad2,
  House,
  Square,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

export function Joystick() {
  const store = useStore();
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const locked = store.running || store.phase !== "connected";
  const caps = store.connection?.capabilities;

  const act = useCallback(
    async (action: string, params: Record<string, unknown> = {}) => {
      try {
        setBusyMsg(null);
        await api.ptz(action, params);
      } catch (e) {
        setBusyMsg(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  // press-and-hold: continuous move on pointerdown, stop on release
  const hold = (vx: number, vy: number) => ({
    onPointerDown: () => act("continuous", { vx, vy }),
    onPointerUp: () => act("stop"),
    onPointerLeave: () => act("stop"),
  });

  // safety: release stops on unmount
  useEffect(() => () => void 0, []);

  if (!store.connection?.hasPtz) return null;

  return (
    <div className="rounded-squircle-xl rounded-xl border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-semibold">
          <Gamepad2 className="size-3.5 text-primary" />
          Manual control
        </span>
        {locked && (
          <span className="text-[10px] text-warning">
            {store.running ? "locked during test run" : "connect first"}
          </span>
        )}
      </div>
      <div className="flex items-center justify-center gap-4">
        {/* D-pad */}
        <div className="grid grid-cols-3 grid-rows-3 gap-1">
          <span />
          <Button variant="outline" size="icon-sm" disabled={locked} aria-label="Tilt up" {...hold(0, 0.5)}>
            <ChevronUp />
          </Button>
          <span />
          <Button variant="outline" size="icon-sm" disabled={locked} aria-label="Pan left" {...hold(-0.5, 0)}>
            <ChevronLeft />
          </Button>
          <Button
            variant="secondary"
            size="icon-sm"
            disabled={locked}
            aria-label="Stop"
            onClick={() => act("stop")}
          >
            <Square className="size-3" />
          </Button>
          <Button variant="outline" size="icon-sm" disabled={locked} aria-label="Pan right" {...hold(0.5, 0)}>
            <ChevronRight />
          </Button>
          <span />
          <Button variant="outline" size="icon-sm" disabled={locked} aria-label="Tilt down" {...hold(0, -0.5)}>
            <ChevronDown />
          </Button>
          <span />
        </div>
        {/* zoom + home */}
        <div className="flex flex-col gap-1">
          {caps?.continuousZoom && (
            <>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={locked}
                aria-label="Zoom in"
                onPointerDown={() => act("continuous", { vz: 0.5 })}
                onPointerUp={() => act("stop")}
                onPointerLeave={() => act("stop")}
              >
                <ZoomIn />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={locked}
                aria-label="Zoom out"
                onPointerDown={() => act("continuous", { vz: -0.5 })}
                onPointerUp={() => act("stop")}
                onPointerLeave={() => act("stop")}
              >
                <ZoomOut />
              </Button>
            </>
          )}
          {caps?.homeSupported && (
            <Button
              variant="outline"
              size="icon-sm"
              disabled={locked}
              aria-label="Go to home position"
              onClick={() => act("goto_home")}
            >
              <House />
            </Button>
          )}
        </div>
      </div>
      {busyMsg && (
        <p className="mt-2 break-all text-center text-[10px] text-destructive">
          {busyMsg}
        </p>
      )}
    </div>
  );
}
