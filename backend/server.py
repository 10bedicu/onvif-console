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
_go2rtc_proc: subprocess.Popen | None = None


def engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = Engine(asyncio.get_event_loop())
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


def _ensure_go2rtc() -> bool:
    """Use an already-running go2rtc, or spawn one if the binary exists."""
    global _go2rtc_proc
    if _go2rtc_running():
        return True
    binary = shutil.which("go2rtc")
    if not binary:
        return False
    cfg = os.path.join(tempfile.gettempdir(), "onvif-console-go2rtc.yaml")
    with open(cfg, "w") as f:
        f.write('api:\n  listen: "127.0.0.1:1984"\n'
                'webrtc:\n  listen: ":18555"\n'
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
    """Called on connect: wire the camera RTSP into go2rtc if possible."""
    rtsp = _rtsp_uri()
    info: dict = {"mode": "none", "rtsp": rtsp is not None}
    if rtsp and _ensure_go2rtc():
        try:
            httpx.put(f"{GO2RTC_API}/api/streams",
                      params={"name": STREAM_NAME, "src": rtsp}, timeout=3)
            info = {"mode": "webrtc",
                    "embedUrl": f"{GO2RTC_PUBLIC}/stream.html?src={STREAM_NAME}&mode=webrtc,mse",
                    "rtsp": True}
            app.state.stream_info = info
            return info
        except Exception:
            pass
    if _snapshot_uri():
        info = {"mode": "snapshot", "snapshotEndpoint": "/api/snapshot", "rtsp": rtsp is not None}
    app.state.stream_info = info
    return info


def _stream_info() -> dict:
    return getattr(app.state, "stream_info", {"mode": "none"})


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
    uri = _snapshot_uri()
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
