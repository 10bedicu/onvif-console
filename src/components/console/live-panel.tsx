"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE, snapshotUrl } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Camera, MonitorPlay, VideoOff } from "lucide-react";

function SnapshotView() {
  const [tick, setTick] = useState(0);
  const [alive, setAlive] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 900);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${snapshotUrl()}?t=${tick}`}
        alt="Camera snapshot"
        className="h-full w-full object-contain"
        onError={() => setAlive(false)}
        onLoad={() => setAlive(true)}
      />
      {!alive && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-placeholder-foreground">
          snapshot unavailable…
        </div>
      )}
      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white">
        <Camera className="size-3" /> Snapshot ~1 fps
      </span>
    </>
  );
}

export function LivePanel() {
  const { stream, status } = useStore();
  const moving =
    status?.moveStatus.panTilt === "MOVING" ||
    status?.moveStatus.zoom === "MOVING";

  return (
    <div className="overflow-hidden rounded-squircle-xl rounded-xl border bg-card">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-2 text-xs font-semibold">
          <MonitorPlay className="size-3.5 text-primary" />
          Live view
        </span>
        {status && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 font-mono text-[10px]",
              moving ? "text-primary" : "text-placeholder-foreground",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                moving ? "status-pulse bg-primary" : "bg-success",
              )}
            />
            {moving ? "MOVING" : "IDLE"}
          </span>
        )}
      </div>
      <div className="relative aspect-video w-full bg-black">
        {stream?.mode === "webrtc" && stream.embedUrl ? (
          <iframe
            src={stream.embedUrl}
            className="h-full w-full border-0"
            allow="autoplay"
            title="Live camera stream"
          />
        ) : stream?.mode === "snapshot" ? (
          <SnapshotView />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-placeholder-foreground">
            <VideoOff className="size-6" />
            <span className="text-xs">
              Live stream placeholder — install{" "}
              <code className="font-mono">go2rtc</code> for WebRTC video
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function PositionViz() {
  const { status, connection } = useStore();
  const trail = useRef<{ x: number; y: number }[]>([]);
  const pos = status?.position;

  if (pos) {
    const last = trail.current[trail.current.length - 1];
    if (!last || Math.abs(last.x - pos.pan) > 1e-4 || Math.abs(last.y - pos.tilt) > 1e-4) {
      trail.current = [...trail.current, { x: pos.pan, y: pos.tilt }].slice(-60);
    }
  }

  if (!connection?.hasPtz) return null;

  // Camera readback space is typically [0,1] or [-1,1]; normalize adaptively.
  const norm = (v: number) => {
    // if any observed value is < 0 assume [-1,1]
    const isSigned = trail.current.some((p) => p.x < 0 || p.y < 0);
    return isSigned ? (v + 1) / 2 : v;
  };

  const W = 100;
  const H = 60;

  return (
    <div className="rounded-squircle-xl rounded-xl border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold">Pan / Tilt position</span>
        {pos && (
          <span className="font-mono text-[10px] text-placeholder-foreground">
            pan {pos.pan.toFixed(3)} · tilt {pos.tilt.toFixed(3)}
            {pos.zoom != null && ` · zoom ${pos.zoom.toFixed(2)}`}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded-md bg-soft-background dark:bg-neutral-950/60"
        aria-label="Camera pan/tilt position map"
      >
        {/* grid */}
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f} className="stroke-border" strokeWidth="0.3">
            <line x1={W * f} y1="0" x2={W * f} y2={H} />
            <line x1="0" y1={H * f} x2={W} y2={H * f} />
          </g>
        ))}
        {/* trail */}
        {trail.current.length > 1 && (
          <polyline
            fill="none"
            className="stroke-primary/40"
            strokeWidth="0.8"
            strokeLinejoin="round"
            points={trail.current
              .map((p) => `${norm(p.x) * W},${H - norm(p.y) * H}`)
              .join(" ")}
          />
        )}
        {/* current position */}
        {pos && (
          <g>
            <circle
              cx={norm(pos.pan) * W}
              cy={H - norm(pos.tilt) * H}
              r="2.2"
              className="fill-primary"
            />
            <circle
              cx={norm(pos.pan) * W}
              cy={H - norm(pos.tilt) * H}
              r="4"
              className={cn(
                "fill-none stroke-primary/50",
                (status?.moveStatus.panTilt === "MOVING" ||
                  status?.moveStatus.zoom === "MOVING") &&
                  "status-pulse",
              )}
              strokeWidth="0.6"
            />
          </g>
        )}
      </svg>
    </div>
  );
}

export { API_BASE };
