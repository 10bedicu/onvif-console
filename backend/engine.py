"""
Test engine for the ONVIF camera testing console.

Wraps the vendor-neutral PTZClient with:
  * an instrumented client that emits every ONVIF call as an event
  * an event bus (asyncio queues) feeding the UI over SSE
  * a registry of workflow tests mirroring the pytest suite, each emitting
    granular progress / log / check events so the UI can render an
    agentic, streaming view of what is happening on the camera.

All camera I/O is synchronous (zeep), so tests run in a worker thread and
publish events back onto the asyncio loop thread-safely.
"""
from __future__ import annotations

import asyncio
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from onvif_ptz import PTZClient


# ──────────────────────────────────────────────────────────────────────────
# Event bus
# ──────────────────────────────────────────────────────────────────────────

class EventBus:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.subscribers: list[asyncio.Queue] = []
        self.call_history: list[dict] = []   # ring buffer of ONVIF call events

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self.subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self.subscribers:
            self.subscribers.remove(q)

    def publish(self, event: dict):
        """Thread-safe publish from worker threads."""
        event.setdefault("ts", time.time())
        if event.get("type") == "call":
            self.call_history.append(event)
            del self.call_history[:-500]

        def _put():
            for q in list(self.subscribers):
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    pass

        self.loop.call_soon_threadsafe(_put)


# ──────────────────────────────────────────────────────────────────────────
# Instrumented client
# ──────────────────────────────────────────────────────────────────────────

TRACED_OPS = {
    "get_status": "GetStatus",
    "relative_move": "RelativeMove",
    "absolute_move": "AbsoluteMove",
    "continuous_move": "ContinuousMove",
    "stop": "Stop",
    "get_presets": "GetPresets",
    "set_preset": "SetPreset",
    "goto_preset": "GotoPreset",
    "remove_preset": "RemovePreset",
    "goto_home": "GotoHomePosition",
    "set_home": "SetHomePosition",
}


class InstrumentedPTZClient(PTZClient):
    """PTZClient that reports every ONVIF operation to the event bus."""

    def __init__(self, bus: EventBus, **kw):
        self._bus = bus
        self._suppress_polls = False
        super().__init__(**kw)

    def _emit(self, op: str, params: Any, dur_ms: float, ok: bool, error: str | None):
        # GetStatus is called at polling frequency; tag it so the UI can
        # de-emphasize/collapse poll chatter.
        self._bus.publish({
            "type": "call",
            "id": uuid.uuid4().hex[:8],
            "op": op,
            "params": params,
            "durationMs": round(dur_ms, 1),
            "ok": ok,
            "error": error,
            "kind": "poll" if op == "GetStatus" else "command",
        })


def _traced(method_name: str, op: str):
    orig = getattr(PTZClient, method_name)

    def wrapper(self: InstrumentedPTZClient, *args, **kwargs):
        if op == "GetStatus" and self._suppress_polls:
            return orig(self, *args, **kwargs)
        t0 = time.time()
        try:
            result = orig(self, *args, **kwargs)
            self._emit(op, _fmt_params(args, kwargs), (time.time() - t0) * 1000, True, None)
            return result
        except Exception as e:
            self._emit(op, _fmt_params(args, kwargs), (time.time() - t0) * 1000, False, str(e)[:200])
            raise

    return wrapper


def _fmt_params(args, kwargs):
    parts = [repr(a) for a in args] + [f"{k}={v!r}" for k, v in kwargs.items()]
    s = ", ".join(parts)
    return s if len(s) <= 120 else s[:117] + "..."


for _m, _op in TRACED_OPS.items():
    setattr(InstrumentedPTZClient, _m, _traced(_m, _op))


# ──────────────────────────────────────────────────────────────────────────
# Test context & results
# ──────────────────────────────────────────────────────────────────────────

class RunCancelled(Exception):
    pass


class SkipTest(Exception):
    def __init__(self, reason: str):
        self.reason = reason


@dataclass
class Check:
    name: str
    passed: bool
    detail: str = ""


@dataclass
class TestResult:
    id: str
    status: str = "pending"        # pending | running | passed | failed | skipped | error
    checks: list = field(default_factory=list)
    logs: list = field(default_factory=list)
    startedAt: float | None = None
    finishedAt: float | None = None
    detail: str = ""

    def to_dict(self):
        return {
            "id": self.id, "status": self.status,
            "checks": [c.__dict__ for c in self.checks],
            "logs": self.logs,
            "startedAt": self.startedAt, "finishedAt": self.finishedAt,
            "durationMs": round((self.finishedAt - self.startedAt) * 1000)
            if self.startedAt and self.finishedAt else None,
            "detail": self.detail,
        }


class TestCtx:
    """Passed to each test body: emits events + records the result."""

    def __init__(self, engine: "Engine", test_id: str, total_steps: int):
        self.engine = engine
        self.id = test_id
        self.total = max(total_steps, 1)
        self.done = 0
        self.result = TestResult(id=test_id)

    @property
    def cam(self) -> InstrumentedPTZClient:
        return self.engine.client

    def _cancel_check(self):
        if self.engine.cancel_flag.is_set():
            raise RunCancelled()

    def log(self, msg: str, level: str = "info"):
        entry = {"ts": time.time(), "level": level, "msg": msg}
        self.result.logs.append(entry)
        self.engine.bus.publish({"type": "log", "testId": self.id, **entry})

    def step(self, msg: str):
        """Advance progress + log the phase."""
        self._cancel_check()
        self.done += 1
        pct = min(int(self.done / self.total * 100), 99)
        self.log(msg)
        self.engine.bus.publish({"type": "test", "testId": self.id,
                                 "status": "running", "progress": pct})

    def check(self, name: str, passed: bool, detail: str = ""):
        self.result.checks.append(Check(name, passed, detail))
        self.log(f"{'✓' if passed else '✗'} {name}" + (f" — {detail}" if detail else ""),
                 "success" if passed else "error")

    def skip(self, reason: str):
        raise SkipTest(reason)


# ──────────────────────────────────────────────────────────────────────────
# Helpers shared by tests
# ──────────────────────────────────────────────────────────────────────────

def near(a, b, tol=0.05):
    return abs(a - b) <= tol


def fmt(p):
    if not p:
        return "None"
    z = f", zoom={p[2]:.3f}" if p[2] is not None else ""
    return f"(pan={p[0]:+.3f}, tilt={p[1]:+.3f}{z})"


def seq_str(obs, axis):
    return " → ".join(obs.axis_sequence(axis))


def observe(ctx: TestCtx, axis="pantilt", timeout=30.0):
    """poll_until_idle with poll suppression (avoid flooding the call log)."""
    cam = ctx.cam
    cam._suppress_polls = True
    try:
        return cam.poll_until_idle(axis=axis, timeout=timeout)
    finally:
        cam._suppress_polls = False


PRESET_TEST_NAME = "ONVIFTEST"


# ──────────────────────────────────────────────────────────────────────────
# Test bodies (mirroring the pytest suite, vendor-neutral)
# ──────────────────────────────────────────────────────────────────────────

def t_connectivity(ctx: TestCtx):
    ctx.step("Requesting device information…")
    info = ctx.cam.devicemgmt.GetDeviceInformation()
    ctx.check("GetDeviceInformation returns manufacturer + model",
              bool(info.Manufacturer and info.Model),
              f"{info.Manufacturer} {info.Model} fw={info.FirmwareVersion}")
    ctx.step("Enumerating media profiles…")
    ctx.check("Camera exposes at least one media profile",
              len(ctx.cam.profiles) >= 1,
              f"{len(ctx.cam.profiles)} profile(s), using {ctx.cam.profile.Name!r}")
    ctx.step("Checking PTZ node…")
    ctx.check("PTZ node discovered", ctx.cam.has_ptz,
              f"node={getattr(ctx.cam.node, 'token', None)!r}" if ctx.cam.has_ptz
              else "no PTZ node (fixed camera?)")


def t_get_status(ctx: TestCtx):
    if not ctx.cam.has_ptz:
        ctx.skip("camera exposes no PTZ node")
    ctx.step("Calling GetStatus…")
    st = ctx.cam.get_status()
    pos = ctx.cam.position()
    ms = st.MoveStatus
    ctx.check("Position reported", st.Position.PanTilt is not None, fmt(pos))
    ctx.check("MoveStatus reported per-axis",
              getattr(ms, "PanTilt", None) in ("IDLE", "MOVING"),
              f"PanTilt={getattr(ms, 'PanTilt', None)}, Zoom={getattr(ms, 'Zoom', None)}")


def _center(ctx: TestCtx):
    if ctx.cam.caps.absolute_pantilt:
        ctx.cam.absolute_move(*ctx.cam.abs_pantilt(0.5, 0.5), 0.0)
        observe(ctx)


def t_relative_move(ctx: TestCtx):
    cam = ctx.cam
    if not cam.caps.relative_pantilt:
        ctx.skip("camera does not advertise relative pan/tilt")
    ctx.step("Centering camera…")
    _center(ctx)
    start = cam.stable_position()
    ctx.step(f"Start position {fmt(start)} — issuing RelativeMove…")
    dx, dy = cam.rel_translation(-0.30, -0.20)
    cam.relative_move(dx=dx, dy=dy)
    ctx.step("Polling GetStatus for MoveStatus transition…")
    obs = observe(ctx)
    ctx.log(f"MoveStatus sequence: {seq_str(obs, 'pantilt')} "
            f"({len(obs.samples)} samples)", "note")
    ctx.check("MoveStatus transitioned MOVING → IDLE",
              obs.transitioned("pantilt"), seq_str(obs, "pantilt"))
    end = obs.final_pos
    ctx.check("Position changed",
              bool(end and (abs(end[0] - start[0]) > 0.02 or abs(end[1] - start[1]) > 0.02)),
              f"{fmt(start)} → {fmt(end)}")


def t_absolute_move(ctx: TestCtx):
    cam = ctx.cam
    if not cam.caps.absolute_pantilt:
        ctx.skip("camera does not advertise absolute pan/tilt")
    A = cam.abs_pantilt(0.60, 0.55)
    B = cam.abs_pantilt(0.30, 0.35)

    ctx.step(f"AbsoluteMove → target A (pan={A[0]:+.2f}, tilt={A[1]:+.2f})…")
    cam.absolute_move(*A, 0.0)
    obs = observe(ctx)
    ctx.log(f"MoveStatus sequence: {seq_str(obs, 'pantilt')}", "note")
    ctx.check("MoveStatus transitioned MOVING → IDLE",
              obs.transitioned("pantilt"), seq_str(obs, "pantilt"))
    posA1 = cam.stable_position()

    ctx.step(f"AbsoluteMove → target B (pan={B[0]:+.2f}, tilt={B[1]:+.2f})…")
    cam.absolute_move(*B, 0.0)
    observe(ctx)
    posB = cam.stable_position()

    ctx.step("Returning to target A to verify repeatability…")
    cam.absolute_move(*A, 0.0)
    observe(ctx)
    posA2 = cam.stable_position()

    ctx.check("Repeatable: same command → same readback",
              near(posA1[0], posA2[0]) and near(posA1[1], posA2[1]),
              f"A#1={fmt(posA1)}  A#2={fmt(posA2)}")
    ctx.check("Distinct commands → distinct readbacks",
              abs(posA2[0] - posB[0]) > 0.05 or abs(posA2[1] - posB[1]) > 0.05,
              f"A={fmt(posA2)}  B={fmt(posB)}")


def t_zoom(ctx: TestCtx):
    cam = ctx.cam
    if not cam.caps.absolute_zoom:
        ctx.skip("camera does not advertise absolute zoom")
    center = cam.abs_pantilt(0.5, 0.5)
    z0 = cam.position()[2]
    ctx.step("Zooming in to 50%…")
    cam.absolute_move(*center, cam.zoom_target(0.5))
    obs = observe(ctx, axis="zoom")
    z1 = cam.stable_position()[2]
    moved_by_status = obs.reached_moving("zoom") and obs.returned_idle("zoom")
    moved_by_pos = z0 is not None and z1 is not None and abs(z1 - z0) > 0.02
    ctx.log(f"Zoom MoveStatus sequence: {seq_str(obs, 'zoom')}", "note")
    ctx.check("Zoom motor actuated (MoveStatus transition or position change)",
              moved_by_status or moved_by_pos,
              f"status={seq_str(obs, 'zoom')}  zoomPos {z0} → {z1}")
    if not moved_by_pos:
        ctx.log("Camera does not report a changing zoom position readback", "note")
    ctx.step("Zooming back out…")
    cam.absolute_move(*center, cam.zoom_target(0.0))
    observe(ctx, axis="zoom")


def t_continuous_move(ctx: TestCtx):
    cam = ctx.cam
    if not cam.caps.continuous_pantilt:
        ctx.skip("camera does not advertise continuous pan/tilt")
    ctx.step("Centering camera…")
    _center(ctx)
    p0 = cam.stable_position()
    vx, vy = cam.velocity(0.8, 0.0)
    ctx.step(f"ContinuousMove at velocity (vx={vx:+.2f})…")
    cam.continuous_move(vx=vx, vy=vy)
    saw_moving = False
    cam._suppress_polls = True
    t0 = time.time()
    while time.time() - t0 < 1.5:
        if cam.move_status()[0] == "MOVING":
            saw_moving = True
        time.sleep(0.1)
    p_during = cam.position()
    cam._suppress_polls = False
    ctx.step("Issuing Stop…")
    cam.stop()
    p1 = cam.stable_position()
    ctx.check("Camera physically pans during continuous move",
              abs(p_during[0] - p0[0]) > 0.02 or abs(p_during[1] - p0[1]) > 0.02,
              f"{fmt(p0)} → {fmt(p_during)}")
    ctx.check("Motion halts after Stop",
              abs(cam.position()[0] - p1[0]) < 0.02, f"stopped near {fmt(p1)}")
    ctx.log(f"MoveStatus reported MOVING during continuous move: {saw_moving} "
            "(optional per ONVIF — some cameras only track positioning moves)", "note")


def t_presets(ctx: TestCtx):
    cam = ctx.cam
    if not cam.caps.absolute_pantilt:
        ctx.skip("needs absolute pan/tilt to verify positions")
    if cam.caps.max_presets == 0:
        ctx.skip("camera advertises 0 presets")

    ctx.step("Cleaning up any leftover test preset…")
    for p in cam.get_presets():
        if getattr(p, "Name", None) == PRESET_TEST_NAME:
            cam.remove_preset(p.token)
    before = len(cam.get_presets())

    ctx.step("Moving to a distinct position to save…")
    cam.absolute_move(*cam.abs_pantilt(0.30, 0.35), 0.0)
    observe(ctx)
    saved = cam.stable_position()

    ctx.step(f"SetPreset {PRESET_TEST_NAME!r} at {fmt(saved)}…")
    token = cam.set_preset(PRESET_TEST_NAME)
    ctx.check("SetPreset returned a token", bool(token), f"token={token!r}")

    presets = cam.get_presets()
    ctx.check("GetPresets lists the new preset",
              any(p.token == token for p in presets),
              f"count {before} → {len(presets)}")

    ctx.step("Moving away, then GotoPreset…")
    cam.absolute_move(*cam.abs_pantilt(0.70, 0.65), 0.0)
    observe(ctx)
    cam.goto_preset(token)
    obs = observe(ctx)
    ctx.log(f"MoveStatus sequence: {seq_str(obs, 'pantilt')}", "note")
    ctx.check("GotoPreset transitioned MOVING → IDLE",
              obs.transitioned("pantilt"), seq_str(obs, "pantilt"))
    end = cam.stable_position()
    ctx.check("Returned to the saved position",
              near(end[0], saved[0], 0.06) and near(end[1], saved[1], 0.06),
              f"saved={fmt(saved)}  actual={fmt(end)}")

    ctx.step("RemovePreset…")
    cam.remove_preset(token)
    ctx.check("Preset removed",
              all(p.token != token for p in cam.get_presets()))


def t_home(ctx: TestCtx):
    cam = ctx.cam
    if not cam.caps.home_supported:
        ctx.skip("camera does not advertise HomeSupported")
    if not cam.caps.absolute_pantilt:
        ctx.skip("needs absolute pan/tilt to verify position")

    ctx.step("Moving to a position to define as home…")
    cam.absolute_move(*cam.abs_pantilt(0.65, 0.60), 0.0)
    observe(ctx)
    home = cam.stable_position()
    set_home_ok = True
    ctx.step("SetHomePosition…")
    try:
        cam.set_home()
        ctx.check("SetHomePosition accepted", True, f"home={fmt(home)}")
    except Exception as e:
        set_home_ok = False
        ctx.log(f"SetHomePosition not supported ({str(e)[:60]}); "
                "testing GotoHome against factory home", "note")

    ctx.step("Moving away, then GotoHomePosition…")
    cam.absolute_move(*cam.abs_pantilt(0.35, 0.40), 0.0)
    observe(ctx)
    cam.goto_home()
    obs = observe(ctx)
    ctx.log(f"MoveStatus sequence: {seq_str(obs, 'pantilt')}", "note")
    ctx.check("GotoHome transitioned MOVING → IDLE",
              obs.transitioned("pantilt"), seq_str(obs, "pantilt"))
    if set_home_ok:
        end = cam.stable_position()
        ctx.check("Returned to the set home position",
                  near(end[0], home[0], 0.06) and near(end[1], home[1], 0.06),
                  f"home={fmt(home)}  actual={fmt(end)}")


@dataclass
class TestDef:
    id: str
    name: str
    description: str
    body: Callable
    steps: int


TESTS: list[TestDef] = [
    TestDef("connectivity", "Connectivity & Profiles",
            "Device information, media profiles, and PTZ node discovery.",
            t_connectivity, 3),
    TestDef("get_status", "GetStatus",
            "Position and per-axis MoveStatus are reported.",
            t_get_status, 1),
    TestDef("relative_move", "Relative Move",
            "RelativeMove with IDLE → MOVING → IDLE transition and position change.",
            t_relative_move, 3),
    TestDef("absolute_move", "Absolute Move",
            "AbsoluteMove transition, repeatability, and distinctness.",
            t_absolute_move, 3),
    TestDef("zoom", "Zoom",
            "Absolute zoom actuation via MoveStatus or position readback.",
            t_zoom, 2),
    TestDef("continuous_move", "Continuous Move & Stop",
            "Continuous pan with velocity, then Stop halts motion.",
            t_continuous_move, 3),
    TestDef("presets", "Preset Lifecycle",
            "SetPreset → GetPresets → GotoPreset → RemovePreset round-trip.",
            t_presets, 5),
    TestDef("home", "Home Position",
            "SetHomePosition and GotoHomePosition round-trip.",
            t_home, 3),
]

TESTS_BY_ID = {t.id: t for t in TESTS}


# ──────────────────────────────────────────────────────────────────────────
# Engine
# ──────────────────────────────────────────────────────────────────────────

class Engine:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.bus = EventBus(loop)
        self.client: InstrumentedPTZClient | None = None
        self.poller_client: PTZClient | None = None
        self.connection: dict | None = None

        self.results: dict[str, TestResult] = {}
        self.run_thread: threading.Thread | None = None
        self.cancel_flag = threading.Event()
        self.camera_lock = threading.Lock()   # serializes tests vs joystick
        self.run_meta: dict | None = None

        self._poller_stop = threading.Event()
        self._poller_thread: threading.Thread | None = None

    # ---------- connection ----------
    def connect(self, host: str, port: int, user: str, passwd: str) -> dict:
        self.disconnect()
        self.client = InstrumentedPTZClient(
            self.bus, host=host, port=port, user=user, passwd=passwd)
        # Separate plain connection for the live status poller so its
        # high-frequency GetStatus neither floods the call log nor contends
        # with test SOAP calls on the same transport.
        self.poller_client = PTZClient(host=host, port=port, user=user, passwd=passwd)

        info = self.client.devicemgmt.GetDeviceInformation()
        caps = self.client.caps
        self.connection = {
            "host": host, "port": port, "user": user,
            "device": {
                "manufacturer": info.Manufacturer, "model": info.Model,
                "firmware": info.FirmwareVersion, "serial": info.SerialNumber,
            },
            "profiles": [{"token": p.token, "name": getattr(p, "Name", None)}
                         for p in self.client.profiles],
            "hasPtz": self.client.has_ptz,
            "capabilities": {
                "absolutePanTilt": caps.absolute_pantilt,
                "relativePanTilt": caps.relative_pantilt,
                "continuousPanTilt": caps.continuous_pantilt,
                "absoluteZoom": caps.absolute_zoom,
                "relativeZoom": caps.relative_zoom,
                "continuousZoom": caps.continuous_zoom,
                "homeSupported": caps.home_supported,
                "maxPresets": caps.max_presets,
                "absPanTiltRange": caps.abs_pantilt_range,
                "absZoomRange": caps.abs_zoom_range,
            },
            "connectedAt": time.time(),
        }
        self.results = {t.id: TestResult(id=t.id) for t in TESTS}
        self._start_poller()
        self.bus.publish({"type": "connection", "connected": True,
                          "connection": self.connection})
        return self.connection

    def disconnect(self):
        self._stop_poller()
        if self.connection:
            self.bus.publish({"type": "connection", "connected": False})
        self.client = None
        self.poller_client = None
        self.connection = None

    # ---------- live status poller ----------
    def _start_poller(self):
        self._poller_stop.clear()
        self._poller_thread = threading.Thread(target=self._poll_loop, daemon=True)
        self._poller_thread.start()

    def _stop_poller(self):
        self._poller_stop.set()
        if self._poller_thread:
            self._poller_thread.join(timeout=2)
            self._poller_thread = None

    def _poll_loop(self):
        while not self._poller_stop.is_set():
            client = self.poller_client
            if client is None or not client.has_ptz:
                time.sleep(1.0)
                continue
            try:
                st = client.get_status()
                pt = st.Position.PanTilt
                z = st.Position.Zoom
                ms = st.MoveStatus
                self.bus.publish({
                    "type": "status",
                    "position": {"pan": pt.x, "tilt": pt.y,
                                 "zoom": z.x if z else None},
                    "moveStatus": {"panTilt": getattr(ms, "PanTilt", None),
                                   "zoom": getattr(ms, "Zoom", None)},
                })
            except Exception:
                pass
            time.sleep(0.25)

    # ---------- test running ----------
    @property
    def running(self) -> bool:
        return self.run_thread is not None and self.run_thread.is_alive()

    def start_run(self, ids: list[str] | None = None) -> list[str]:
        if not self.client:
            raise RuntimeError("not connected")
        if self.running:
            raise RuntimeError("a run is already in progress")
        ids = ids or [t.id for t in TESTS]
        unknown = [i for i in ids if i not in TESTS_BY_ID]
        if unknown:
            raise ValueError(f"unknown test ids: {unknown}")
        self.cancel_flag.clear()
        self.run_thread = threading.Thread(target=self._run, args=(ids,), daemon=True)
        self.run_thread.start()
        return ids

    def cancel_run(self):
        self.cancel_flag.set()

    def _run(self, ids: list[str]):
        self.run_meta = {
            "id": uuid.uuid4().hex[:12],
            "startedAt": time.time(),
            "finishedAt": None,
            "testIds": ids,
            "connection": self.connection,
        }
        self.bus.publish({"type": "run", "status": "started",
                          "runId": self.run_meta["id"], "testIds": ids})

        original = None
        with self.camera_lock:
            try:
                if self.client.has_ptz:
                    original = self.client.position()
            except Exception:
                pass

            for tid in ids:
                tdef = TESTS_BY_ID[tid]
                ctx = TestCtx(self, tid, tdef.steps)
                self.results[tid] = ctx.result
                ctx.result.status = "running"
                ctx.result.startedAt = time.time()
                self.bus.publish({"type": "test", "testId": tid,
                                  "status": "running", "progress": 0})
                try:
                    if self.cancel_flag.is_set():
                        raise RunCancelled()
                    tdef.body(ctx)
                    failed = any(not c.passed for c in ctx.result.checks)
                    ctx.result.status = "failed" if failed else "passed"
                except SkipTest as s:
                    ctx.result.status = "skipped"
                    ctx.result.detail = s.reason
                    ctx.log(f"Skipped — {s.reason}", "note")
                except RunCancelled:
                    ctx.result.status = "error"
                    ctx.result.detail = "cancelled"
                    ctx.log("Run cancelled", "error")
                    ctx.result.finishedAt = time.time()
                    self._publish_test_final(ctx.result)
                    break
                except Exception as e:
                    ctx.result.status = "error"
                    ctx.result.detail = f"{type(e).__name__}: {str(e)[:200]}"
                    ctx.log(ctx.result.detail, "error")
                ctx.result.finishedAt = time.time()
                self._publish_test_final(ctx.result)

            # restore original position (best effort)
            try:
                if original and self.client.caps.absolute_pantilt and not self.cancel_flag.is_set():
                    self.client._suppress_polls = True
                    self.client.absolute_move(original[0], original[1], original[2] or 0.0)
                    self.client.poll_until_idle(axis="pantilt")
                    self.client._suppress_polls = False
            except Exception:
                pass

        self.run_meta["finishedAt"] = time.time()
        self.bus.publish({"type": "run", "status": "finished",
                          "runId": self.run_meta["id"],
                          "summary": self.summary()})

    def _publish_test_final(self, r: TestResult):
        self.bus.publish({"type": "test", "testId": r.id, "status": r.status,
                          "progress": 100 if r.status == "passed" else None,
                          "result": r.to_dict()})

    def summary(self) -> dict:
        counts = {"passed": 0, "failed": 0, "skipped": 0, "error": 0, "pending": 0}
        for r in self.results.values():
            if r.status == "running":
                counts["pending"] += 1
            elif r.status in counts:
                counts[r.status] += 1
        return counts

    def report(self) -> dict | None:
        if not self.run_meta:
            return None
        return {
            **self.run_meta,
            "summary": self.summary(),
            "results": [self.results[t.id].to_dict()
                        for t in TESTS if t.id in self.results],
            "tests": [{"id": t.id, "name": t.name, "description": t.description}
                      for t in TESTS],
            "calls": self.bus.call_history[-300:],
        }

    # ---------- manual PTZ (joystick) ----------
    def manual(self, action: str, params: dict) -> dict:
        if not self.client:
            raise RuntimeError("not connected")
        if self.running:
            raise RuntimeError("a test run is in progress — manual control is locked")
        with self.camera_lock:
            cam = self.client
            if action == "continuous":
                vx, vy = cam.velocity(params.get("vx", 0), params.get("vy", 0))
                cam.continuous_move(vx=vx, vy=vy, vz=params.get("vz", 0))
            elif action == "stop":
                cam.stop()
            elif action == "relative":
                dx, dy = cam.rel_translation(params.get("dx", 0), params.get("dy", 0))
                cam.relative_move(dx=dx, dy=dy, dz=params.get("dz", 0))
            elif action == "absolute_zoom":
                pos = cam.position()
                cam.absolute_move(pos[0], pos[1], cam.zoom_target(params.get("z", 0)))
            elif action == "goto_preset":
                cam.goto_preset(params["token"])
            elif action == "goto_home":
                cam.goto_home()
            elif action == "set_preset":
                token = cam.set_preset(params["name"])
                return {"token": token}
            elif action == "remove_preset":
                cam.remove_preset(params["token"])
            else:
                raise ValueError(f"unknown action {action!r}")
        return {"ok": True}

    def presets(self) -> list[dict]:
        if not self.client or not self.client.has_ptz:
            return []
        with self.camera_lock:
            return [{"token": p.token, "name": getattr(p, "Name", None)}
                    for p in self.client.get_presets()]
