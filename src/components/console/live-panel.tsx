"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE, snapshotUrl } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Camera, MonitorPlay, RotateCcw, VideoOff } from "lucide-react";

function SnapshotView() {
  // Sequential polling: fetch the next frame only after the previous one
  // finishes (cameras can take >1s per frame while also serving RTSP), and
  // swap via blob URLs so the previous frame stays visible — no flicker.
  const [src, setSrc] = useState<string | null>(null);
  const [alive, setAlive] = useState(true);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let prevUrl: string | null = null;

    const loop = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`${snapshotUrl()}?t=${Date.now()}`);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (stopped) return;
        const url = URL.createObjectURL(blob);
        setSrc(url);
        setAlive(true);
        if (prevUrl) URL.revokeObjectURL(prevUrl);
        prevUrl = url;
        timer = setTimeout(loop, 400);
      } catch {
        if (stopped) return;
        setAlive(false);
        timer = setTimeout(loop, 2000); // back off on errors
      }
    };
    loop();

    return () => {
      stopped = true;
      clearTimeout(timer);
      if (prevUrl) URL.revokeObjectURL(prevUrl);
    };
  }, []);

  return (
    <>
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="Camera snapshot"
          className="h-full w-full object-contain"
        />
      )}
      {!alive && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-placeholder-foreground">
          snapshot unavailable — retrying…
        </div>
      )}
      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white">
        <Camera className="size-3" /> Snapshot
      </span>
    </>
  );
}

const VIEW_PREF_KEY = "onvif-console-liveview-mode";

export function LivePanel() {
  const { stream, status } = useStore();
  const moving =
    status?.moveStatus.panTilt === "MOVING" ||
    status?.moveStatus.zoom === "MOVING";

  const webrtcOk = stream?.webrtc.available ?? false;
  const snapshotOk = stream?.snapshot.available ?? false;

  // Default to live (WebRTC) when it works; remember the user's choice.
  const [mode, setMode] = useState<"webrtc" | "snapshot" | "none">("none");
  useEffect(() => {
    if (!stream) return;
    const saved =
      typeof window !== "undefined"
        ? (localStorage.getItem(VIEW_PREF_KEY) as "webrtc" | "snapshot" | null)
        : null;
    if (saved === "webrtc" && webrtcOk) setMode("webrtc");
    else if (saved === "snapshot" && snapshotOk) setMode("snapshot");
    else setMode(stream.default);
  }, [stream, webrtcOk, snapshotOk]);

  const pick = (m: "webrtc" | "snapshot") => {
    setMode(m);
    localStorage.setItem(VIEW_PREF_KEY, m);
  };

  // Remount key for the WebRTC iframe. 0 = not yet started; the iframe only
  // mounts after a producer kick so the camera opens a FRESH RTSP session.
  // (Some cameras only emit an H.264 keyframe at session start — a consumer
  // joining an already-running producer would show black video forever.)
  const [streamEpoch, setStreamEpoch] = useState(0);
  const restartStream = async () => {
    try {
      await fetch(`${API_BASE}/api/stream/kick`, { method: "POST" });
    } catch {
      /* best effort */
    }
    setStreamEpoch((n) => n + 1);
  };

  // Auto-kick whenever we enter (or return to) live mode.
  useEffect(() => {
    if (mode !== "webrtc") {
      setStreamEpoch(0);
      return;
    }
    let stale = false;
    (async () => {
      try {
        await fetch(`${API_BASE}/api/stream/kick`, { method: "POST" });
      } catch {
        /* stream may not exist yet — mount anyway */
      }
      if (!stale) setStreamEpoch((n) => n + 1);
    })();
    return () => {
      stale = true;
    };
  }, [mode]);

  return (
    <div className="overflow-hidden rounded-squircle-xl rounded-xl border bg-card">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-2 text-xs font-semibold">
          <MonitorPlay className="size-3.5 text-primary" />
          Live view
        </span>
        <div className="flex items-center gap-2">
          {mode === "webrtc" && (
            <button
              onClick={restartStream}
              title="Restart stream (fixes a stuck/black player)"
              aria-label="Restart stream"
              className="text-placeholder-foreground transition-colors hover:text-foreground"
            >
              <RotateCcw className="size-3" />
            </button>
          )}
          {/* live / snapshot switch — only when both paths are available */}
          {webrtcOk && snapshotOk && (
            <div className="flex overflow-hidden rounded-full border">
              {(
                [
                  ["webrtc", "Live"],
                  ["snapshot", "Snapshot"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => pick(m)}
                  className={cn(
                    "px-2 py-0.5 text-[10px] font-medium transition-colors",
                    mode === m
                      ? "bg-primary text-primary-foreground"
                      : "text-soft-foreground hover:bg-muted",
                  )}
                  aria-pressed={mode === m}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
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
      </div>
      <div className="relative aspect-video w-full bg-black">
        {mode === "webrtc" && stream?.webrtc.embedUrl ? (
          streamEpoch > 0 ? (
            <iframe
              key={streamEpoch}
              src={stream.webrtc.embedUrl}
              className="h-full w-full border-0"
              allow="autoplay"
              title="Live camera stream"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-placeholder-foreground">
              starting stream…
            </div>
          )
        ) : mode === "snapshot" ? (
          <SnapshotView />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-placeholder-foreground">
            <VideoOff className="size-6" />
            <span className="text-xs">
              No video available — install{" "}
              <code className="font-mono">go2rtc</code> for WebRTC live video
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
