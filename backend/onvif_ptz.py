#!/usr/bin/env python3
"""
Reusable ONVIF PTZ client wrapper + helpers for testing any ONVIF-compliant
PTZ camera.

Nothing here is vendor-specific: the client discovers what the camera supports
(PTZ spaces, coordinate ranges, presets, home) from the ONVIF PTZ node, and the
move helpers derive their targets from the camera's *advertised* ranges. Tests
built on top of it assert vendor-neutral invariants (a move transitions
IDLE->MOVING->IDLE, absolute positioning is repeatable, etc.) rather than any
particular camera's numbers.

Connection config is read from the environment (or a .env file):
    ONVIF_HOST, ONVIF_PORT, ONVIF_USER, ONVIF_PASS
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

from onvif import ONVIFCamera


def _find_dotenv():
    """Look for a .env in the cwd, this file's directory, and its parents
    (the repo root holds the .env; this module lives in backend/)."""
    candidates = [os.path.join(os.getcwd(), ".env")]
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(3):
        candidates.append(os.path.join(d, ".env"))
        d = os.path.dirname(d)
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def _load_dotenv(path=None):
    """Minimal .env loader (no external dependency). Real environment variables
    win over the file, so you can override per-run."""
    path = path or _find_dotenv()
    if not path:
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_dotenv()

# Connection config (override via env vars or .env to test any camera).
DEFAULT_HOST = os.environ.get("ONVIF_HOST", "")
DEFAULT_PORT = int(os.environ.get("ONVIF_PORT", "80"))
DEFAULT_USER = os.environ.get("ONVIF_USER", "")
DEFAULT_PASS = os.environ.get("ONVIF_PASS", "")


@dataclass
class StatusSample:
    t: float                # seconds elapsed since polling started
    pantilt: str            # MoveStatus for PanTilt: IDLE / MOVING / UNKNOWN
    zoom: str               # MoveStatus for Zoom
    pos: tuple              # (pan, tilt, zoom)


@dataclass
class MoveObservation:
    samples: list = field(default_factory=list)

    def axis_sequence(self, axis: str) -> list:
        """Collapsed sequence of distinct states for an axis, e.g. [IDLE, MOVING, IDLE]."""
        seq = []
        for s in self.samples:
            v = getattr(s, axis)
            if not seq or seq[-1] != v:
                seq.append(v)
        return seq

    def reached_moving(self, axis: str) -> bool:
        return "MOVING" in self.axis_sequence(axis)

    def returned_idle(self, axis: str) -> bool:
        seq = self.axis_sequence(axis)
        return len(seq) > 0 and seq[-1] == "IDLE"

    def transitioned(self, axis: str) -> bool:
        """True iff we observed ... -> MOVING -> ... -> IDLE."""
        seq = self.axis_sequence(axis)
        return "MOVING" in seq and seq[-1] == "IDLE"

    @property
    def final_pos(self):
        return self.samples[-1].pos if self.samples else None


@dataclass
class PTZCapabilities:
    absolute_pantilt: bool = False
    relative_pantilt: bool = False
    continuous_pantilt: bool = False
    absolute_zoom: bool = False
    relative_zoom: bool = False
    continuous_zoom: bool = False
    home_supported: bool = False
    max_presets: int = 0
    # advertised coordinate ranges: ((xmin,xmax),(ymin,ymax)) or (min,max)
    abs_pantilt_range: tuple | None = None
    rel_pantilt_range: tuple | None = None
    cont_pantilt_range: tuple | None = None
    abs_zoom_range: tuple | None = None


class PTZClient:
    def __init__(self, host=None, port=None, user=None, passwd=None, profile_index=0):
        host = host or DEFAULT_HOST
        if not host:
            raise ValueError(
                "No camera host configured. Set ONVIF_HOST (and ONVIF_USER / "
                "ONVIF_PASS) in your environment or a .env file. "
                "See .env.example."
            )
        self.cam = ONVIFCamera(host, port or DEFAULT_PORT,
                               user or DEFAULT_USER, passwd or DEFAULT_PASS)
        self.devicemgmt = self.cam.create_devicemgmt_service()
        self.media = self.cam.create_media_service()
        self.profiles = self.media.GetProfiles()
        self.profile = self.profiles[profile_index]
        self.token = self.profile.token

        self.ptz = None
        self.node = None
        self.caps = PTZCapabilities()
        self._discover_ptz()

    # ---------- capability discovery ----------
    def _discover_ptz(self):
        """Populate self.ptz / self.node / self.caps, tolerating cameras that
        expose no PTZ at all."""
        try:
            self.ptz = self.cam.create_ptz_service()
            nodes = self.ptz.GetNodes()
        except Exception:
            self.ptz = None
            return
        if not nodes:
            return

        # Prefer the node referenced by the profile's PTZ configuration.
        node_token = None
        cfg = getattr(self.profile, "PTZConfiguration", None)
        if cfg is not None:
            node_token = getattr(cfg, "NodeToken", None)
        self.node = next((n for n in nodes if n.token == node_token), nodes[0])

        sp = getattr(self.node, "SupportedPTZSpaces", None)
        c = self.caps

        def has(attr):
            return bool(getattr(sp, attr, None)) if sp else False

        def rng(attr):
            spaces = getattr(sp, attr, None) if sp else None
            if not spaces:
                return None
            s = spaces[0]
            xr = getattr(s, "XRange", None)
            yr = getattr(s, "YRange", None)
            if xr and yr:
                return ((xr.Min, xr.Max), (yr.Min, yr.Max))
            if xr:
                return (xr.Min, xr.Max)
            return None

        c.absolute_pantilt = has("AbsolutePanTiltPositionSpace")
        c.relative_pantilt = has("RelativePanTiltTranslationSpace")
        c.continuous_pantilt = has("ContinuousPanTiltVelocitySpace")
        c.absolute_zoom = has("AbsoluteZoomPositionSpace")
        c.relative_zoom = has("RelativeZoomTranslationSpace")
        c.continuous_zoom = has("ContinuousZoomVelocitySpace")
        c.home_supported = bool(getattr(self.node, "HomeSupported", False))
        c.max_presets = int(getattr(self.node, "MaximumNumberOfPresets", 0) or 0)
        c.abs_pantilt_range = rng("AbsolutePanTiltPositionSpace")
        c.rel_pantilt_range = rng("RelativePanTiltTranslationSpace")
        c.cont_pantilt_range = rng("ContinuousPanTiltVelocitySpace")
        c.abs_zoom_range = rng("AbsoluteZoomPositionSpace")

    @property
    def has_ptz(self) -> bool:
        return self.ptz is not None and self.node is not None

    # ---------- target helpers (scaled into the camera's advertised ranges) ----------
    def abs_pantilt(self, fx, fy):
        """Map fractions fx,fy in [0,1] to an absolute pan/tilt within range.
        0.5 -> centre. Falls back to the ONVIF-normalized [-1,1] space."""
        r = self.caps.abs_pantilt_range or ((-1.0, 1.0), (-1.0, 1.0))
        (xmin, xmax), (ymin, ymax) = r
        return (xmin + fx * (xmax - xmin), ymin + fy * (ymax - ymin))

    def zoom_target(self, fz):
        r = self.caps.abs_zoom_range or (0.0, 1.0)
        zmin, zmax = r
        return zmin + fz * (zmax - zmin)

    def rel_translation(self, fx, fy):
        """Relative step: fx,fy in [-1,1] scaled by the range's magnitude."""
        r = self.caps.rel_pantilt_range or ((-1.0, 1.0), (-1.0, 1.0))
        (xmin, xmax), (ymin, ymax) = r
        return (fx * max(abs(xmin), abs(xmax)), fy * max(abs(ymin), abs(ymax)))

    def velocity(self, fx, fy):
        r = self.caps.cont_pantilt_range or ((-1.0, 1.0), (-1.0, 1.0))
        (xmin, xmax), (ymin, ymax) = r
        return (fx * max(abs(xmin), abs(xmax)), fy * max(abs(ymin), abs(ymax)))

    # ---------- status ----------
    def get_status(self):
        return self.ptz.GetStatus({"ProfileToken": self.token})

    def position(self):
        st = self.get_status()
        pt = st.Position.PanTilt
        z = st.Position.Zoom
        return (pt.x, pt.y, z.x if z else None)

    def stable_position(self, delay=0.7):
        """Read position after a short settle. Position readback can lag the
        IDLE transition by a fraction of a second on some cameras."""
        time.sleep(delay)
        return self.position()

    def move_status(self):
        ms = self.get_status().MoveStatus
        return (getattr(ms, "PanTilt", "UNKNOWN"), getattr(ms, "Zoom", "UNKNOWN"))

    def sample(self, t0) -> StatusSample:
        st = self.get_status()
        ms = st.MoveStatus
        pt = st.Position.PanTilt
        z = st.Position.Zoom
        return StatusSample(
            t=round(time.time() - t0, 3),
            pantilt=getattr(ms, "PanTilt", "UNKNOWN") or "UNKNOWN",
            zoom=getattr(ms, "Zoom", "UNKNOWN") or "UNKNOWN",
            pos=(pt.x, pt.y, z.x if z else None),
        )

    def poll_until_idle(self, interval=0.12, timeout=30.0, axis="pantilt") -> MoveObservation:
        """
        Poll GetStatus rapidly, capturing the MoveStatus transition sequence.
        Stops once the watched axis has gone MOVING and come back to IDLE
        (or on timeout). Always captures at least the initial + final sample.
        """
        obs = MoveObservation()
        t0 = time.time()
        saw_moving = False
        while True:
            s = self.sample(t0)
            obs.samples.append(s)
            cur = getattr(s, axis)
            if cur == "MOVING":
                saw_moving = True
            if saw_moving and cur == "IDLE":
                break
            if s.t > timeout:
                break
            time.sleep(interval)
        return obs

    # ---------- moves ----------
    def relative_move(self, dx=0.0, dy=0.0, dz=0.0):
        req = self.ptz.create_type("RelativeMove")
        req.ProfileToken = self.token
        req.Translation = {"PanTilt": {"x": dx, "y": dy}, "Zoom": {"x": dz}}
        return self.ptz.RelativeMove(req)

    def absolute_move(self, x, y, z=None):
        req = self.ptz.create_type("AbsoluteMove")
        req.ProfileToken = self.token
        pos = {"PanTilt": {"x": x, "y": y}}
        if z is not None:
            pos["Zoom"] = {"x": z}
        req.Position = pos
        return self.ptz.AbsoluteMove(req)

    def continuous_move(self, vx=0.0, vy=0.0, vz=0.0):
        req = self.ptz.create_type("ContinuousMove")
        req.ProfileToken = self.token
        req.Velocity = {"PanTilt": {"x": vx, "y": vy}, "Zoom": {"x": vz}}
        return self.ptz.ContinuousMove(req)

    def stop(self, pantilt=True, zoom=True):
        req = self.ptz.create_type("Stop")
        req.ProfileToken = self.token
        req.PanTilt = pantilt
        req.Zoom = zoom
        return self.ptz.Stop(req)

    # ---------- presets ----------
    def get_presets(self):
        return self.ptz.GetPresets({"ProfileToken": self.token})

    def set_preset(self, name, token=None):
        req = self.ptz.create_type("SetPreset")
        req.ProfileToken = self.token
        req.PresetName = name
        if token:
            req.PresetToken = token
        return self.ptz.SetPreset(req)  # returns PresetToken

    def goto_preset(self, token):
        req = self.ptz.create_type("GotoPreset")
        req.ProfileToken = self.token
        req.PresetToken = token
        return self.ptz.GotoPreset(req)

    def remove_preset(self, token):
        req = self.ptz.create_type("RemovePreset")
        req.ProfileToken = self.token
        req.PresetToken = token
        return self.ptz.RemovePreset(req)

    # ---------- home ----------
    def goto_home(self):
        req = self.ptz.create_type("GotoHomePosition")
        req.ProfileToken = self.token
        return self.ptz.GotoHomePosition(req)

    def set_home(self):
        req = self.ptz.create_type("SetHomePosition")
        req.ProfileToken = self.token
        return self.ptz.SetHomePosition(req)
