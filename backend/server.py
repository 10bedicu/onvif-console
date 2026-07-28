"""
FastAPI sidecar for the ONVIF camera testing console.

Serves:
  * REST API the static Next.js UI talks to (connect, tests, PTZ, presets)
  * Server-Sent Events stream of engine events (logs, calls, progress, status)
  * Live video: go2rtc WebRTC relay when the go2rtc binary is available,
    with an ONVIF snapshot proxy as fallback
  * The static UI build (../out) when present

Run:  .venv/bin/uvicorn server:app --port 5800
"""
from __future__ import annotations

import asyncio
import atexit
import json
import os
import shutil
import subprocess
import tempfile
import time

import requests as httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import engine as engine_mod
from engine import Engine, TESTS
from store import HistoryStore

# go2rtc relay: API endpoint the sidecar talks to, and the URL the *browser*
# uses for the WebRTC embed (differs when go2rtc runs in another container).
GO2RTC_API = os.environ.get("GO2RTC_API", "http://127.0.0.1:1984")
GO2RTC_PUBLIC = os.environ.get("GO2RTC_PUBLIC_URL", GO2RTC_API)
STREAM_NAME = "camera"

app = FastAPI(title="ONVIF Camera Testing Console")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_engine: Engine | None = None
_store: HistoryStore | None = None
_go2rtc_proc: subprocess.Popen | None = None


def store() -> HistoryStore:
    global _store
    if _store is None:
        _store = HistoryStore()
    return _store


def engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = Engine(asyncio.get_event_loop(), store=store())
    return _engine


@app.on_event("startup")
async def _startup():
    engine()  # bind to the running loop


# ──────────────────────────────────────────────────────────────────────────
# Connection
# ──────────────────────────────────────────────────────────────────────────

class ConnectBody(BaseModel):
    host: str
    port: int = 80
    username: str = ""
    password: str = ""


@app.post("/api/connect")
def connect(body: ConnectBody):
    try:
        conn = engine().connect(body.host, body.port, body.username, body.password)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"{type(e).__name__}: {str(e)[:300]}")
    # Retained only for stream/snapshot auth relay; never sent back to the UI.
    app.state.camera_password = body.password
    stream = _setup_stream()
    return {"connection": conn, "stream": stream,
            "tests": [{"id": t.id, "name": t.name, "description": t.description}
                      for t in TESTS]}


@app.post("/api/disconnect")
def disconnect():
    _teardown_stream()
    engine().disconnect()
    return {"ok": True}


@app.get("/api/session")
def session():
    e = engine()
    if not e.connection:
        raise HTTPException(status_code=404, detail="not connected")
    return {"connection": e.connection,
            "running": e.running,
            "stream": _stream_info(),
            "tests": [{"id": t.id, "name": t.name, "description": t.description}
                      for t in TESTS],
            "results": {tid: r.to_dict() for tid, r in e.results.items()},
            "calls": e.bus.call_history[-100:]}


# ──────────────────────────────────────────────────────────────────────────
# Events (SSE)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/events")
async def events(request: Request):
    e = engine()
    q = e.bus.subscribe()

    async def gen():
        try:
            yield "retry: 2000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            e.bus.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ──────────────────────────────────────────────────────────────────────────
# Tests
# ──────────────────────────────────────────────────────────────────────────

class RunBody(BaseModel):
    ids: list[str] | None = None


@app.post("/api/tests/run")
def run_tests(body: RunBody):
    try:
        ids = engine().start_run(body.ids)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"started": ids}


@app.post("/api/tests/cancel")
def cancel_tests():
    engine().cancel_run()
    return {"ok": True}


@app.get("/api/report")
def report():
    r = engine().report()
    if not r:
        raise HTTPException(status_code=404, detail="no run yet")
    return r


# ──────────────────────────────────────────────────────────────────────────
# History (persisted runs, grouped by camera)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/history")
def history(camera_key: str | None = None, model: str | None = None,
            limit: int = 100, offset: int = 0):
    return {"runs": store().list_runs(camera_key=camera_key, model=model,
                                      limit=min(limit, 500), offset=offset)}


@app.get("/api/history/cameras")
def history_cameras():
    return {"cameras": store().list_cameras()}


@app.get("/api/history/{run_id}")
def history_run(run_id: str):
    r = store().get_run(run_id)
    if not r:
        raise HTTPException(status_code=404, detail="run not found")
    return r


@app.delete("/api/history/{run_id}")
def history_delete(run_id: str):
    if not store().delete_run(run_id):
        raise HTTPException(status_code=404, detail="run not found")
    return {"ok": True}


class ImportBody(BaseModel):
    reports: list[dict]


@app.post("/api/history/import")
def history_import(body: ImportBody):
    """One-time migration of runs the browser saved in localStorage."""
    imported = 0
    for report in body.reports:
        if not report.get("id"):
            continue
        try:
            store().save_run(report, report.get("connection"))
            imported += 1
        except Exception:
            pass
    return {"imported": imported}


# ──────────────────────────────────────────────────────────────────────────
# Manual PTZ (joystick) + presets
# ──────────────────────────────────────────────────────────────────────────

class ManualBody(BaseModel):
    action: str
    params: dict = {}


@app.post("/api/ptz")
def ptz(body: ManualBody):
    try:
        return engine().manual(body.action, body.params)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"{type(e).__name__}: {str(e)[:200]}")


@app.get("/api/presets")
def presets():
    return {"presets": engine().presets()}


# ──────────────────────────────────────────────────────────────────────────
# Live video: go2rtc (WebRTC) with snapshot fallback
# ──────────────────────────────────────────────────────────────────────────

def _rtsp_uri() -> str | None:
    e = engine()
    if not e.client:
        return None
    try:
        media = e.client.media
        req = media.create_type("GetStreamUri")
        req.ProfileToken = e.client.token
        req.StreamSetup = {"Stream": "RTP-Unicast",
                           "Transport": {"Protocol": "RTSP"}}
        uri = media.GetStreamUri(req).Uri
        # Embed credentials for go2rtc.
        conn = e.connection
        if conn and conn["user"] and "://" in uri and "@" not in uri.split("://", 1)[1].split("/", 1)[0]:
            scheme, rest = uri.split("://", 1)
            from urllib.parse import quote
            uri = f"{scheme}://{quote(conn['user'])}:{quote(_password())}@{rest}"
        return uri
    except Exception:
        return None


def _password() -> str:
    # engine doesn't retain the password; stash it at connect time
    return getattr(app.state, "camera_password", "")


def _snapshot_uri() -> str | None:
    e = engine()
    if not e.client:
        return None
    try:
        media = e.client.media
        req = media.create_type("GetSnapshotUri")
        req.ProfileToken = e.client.token
        return media.GetSnapshotUri(req).Uri
    except Exception:
        return None


def _go2rtc_running() -> bool:
    try:
        httpx.get(f"{GO2RTC_API}/api", timeout=1)
        return True
    except Exception:
        return False


def _find_go2rtc_binary() -> str | None:
    """Look on PATH first, then for a project-local backend/bin/go2rtc."""
    binary = shutil.which("go2rtc")
    if binary:
        return binary
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin", "go2rtc")
    if os.path.isfile(local) and os.access(local, os.X_OK):
        return local
    return None


def _ensure_go2rtc() -> bool:
    """Use an already-running go2rtc, or spawn one if the binary exists."""
    global _go2rtc_proc
    if _go2rtc_running():
        return True
    binary = _find_go2rtc_binary()
    if not binary:
        return False
    cfg = os.path.join(tempfile.gettempdir(), "onvif-console-go2rtc.yaml")
    with open(cfg, "w") as f:
        # The explicit loopback candidate matters: on multi-interface hosts
        # (VPNs, multiple NICs) go2rtc may otherwise only offer ICE candidates
        # on interfaces the local browser can't reach, breaking WebRTC.
        f.write('api:\n  listen: "127.0.0.1:1984"\n'
                'webrtc:\n  listen: ":18555"\n'
                '  candidates:\n    - 127.0.0.1:18555\n'
                'rtsp:\n  listen: ""\n')
    _go2rtc_proc = subprocess.Popen(
        [binary, "-config", cfg],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(20):
        if _go2rtc_running():
            return True
        time.sleep(0.25)
    return False


def _setup_stream() -> dict:
    """Called on connect: probe both video paths so the UI can offer a
    live/snapshot toggle. WebRTC (via go2rtc) is the preferred default.

    Both URIs are resolved once here and cached — resolving them per snapshot
    frame would issue overlapping SOAP calls on the shared zeep client, which
    intermittently fail."""
    app.state.snapshot_uri = _snapshot_uri()
    rtsp = _rtsp_uri()
    webrtc_url = None
    if rtsp and _ensure_go2rtc():
        try:
            httpx.put(f"{GO2RTC_API}/api/streams",
                      params={"name": STREAM_NAME, "src": rtsp}, timeout=3)
            # mode=webrtc ONLY (no mse fallback): each extra mode opens another
            # go2rtc consumer, and any lingering consumer keeps the RTSP
            # producer alive across UI reloads. Cameras that only send an IDR
            # frame at RTSP session start then show black video forever. A
            # single consumer guarantees producer teardown -> fresh keyframe.
            webrtc_url = f"{GO2RTC_PUBLIC}/stream.html?src={STREAM_NAME}&mode=webrtc"
        except Exception:
            pass
    snapshot_ok = app.state.snapshot_uri is not None
    info = {
        "webrtc": {"available": webrtc_url is not None, "embedUrl": webrtc_url},
        "snapshot": {"available": snapshot_ok, "endpoint": "/api/snapshot"},
        "default": "webrtc" if webrtc_url else ("snapshot" if snapshot_ok else "none"),
    }
    app.state.stream_info = info
    return info


def _stream_info() -> dict:
    return getattr(
        app.state, "stream_info",
        {"webrtc": {"available": False, "embedUrl": None},
         "snapshot": {"available": False, "endpoint": "/api/snapshot"},
         "default": "none"})


@app.post("/api/stream/kick")
def stream_kick():
    """Force-restart the go2rtc producer (drops all consumers). Useful when a
    camera only emits keyframes on RTSP session start and the player is stuck
    on a black frame."""
    rtsp = None
    try:
        r = httpx.get(f"{GO2RTC_API}/api/streams", timeout=2).json()
        prods = (r.get(STREAM_NAME) or {}).get("producers") or []
        rtsp = prods[0]["url"] if prods else None
    except Exception:
        pass
    if not rtsp:
        raise HTTPException(status_code=404, detail="no go2rtc stream")
    try:
        httpx.delete(f"{GO2RTC_API}/api/streams", params={"src": STREAM_NAME}, timeout=2)
        httpx.put(f"{GO2RTC_API}/api/streams",
                  params={"name": STREAM_NAME, "src": rtsp}, timeout=3)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)[:200])
    return {"ok": True}


def _teardown_stream():
    try:
        httpx.delete(f"{GO2RTC_API}/api/streams",
                     params={"src": STREAM_NAME}, timeout=2)
    except Exception:
        pass
    app.state.stream_info = {"mode": "none"}


@atexit.register
def _kill_go2rtc():
    if _go2rtc_proc:
        _go2rtc_proc.terminate()


@app.get("/api/snapshot")
def snapshot():
    uri = getattr(app.state, "snapshot_uri", None)
    if not uri:
        raise HTTPException(status_code=404, detail="no snapshot uri")
    conn = engine().connection
    auth_digest = httpx.auth.HTTPDigestAuth(conn["user"], _password())
    try:
        r = httpx.get(uri, auth=auth_digest, timeout=5)
        if r.status_code == 401:
            r = httpx.get(uri, auth=(conn["user"], _password()), timeout=5)
        r.raise_for_status()
        return Response(content=r.content,
                        media_type=r.headers.get("Content-Type", "image/jpeg"),
                        headers={"Cache-Control": "no-store"})
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)[:200])


# ──────────────────────────────────────────────────────────────────────────
# Static UI (production: serve the Next.js export)
# ──────────────────────────────────────────────────────────────────────────

_OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "out")
if os.path.isdir(_OUT):
    app.mount("/", StaticFiles(directory=_OUT, html=True), name="ui")
