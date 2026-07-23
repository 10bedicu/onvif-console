#!/usr/bin/env python3
"""
Exploratory ONVIF PTZ workflow test runner (vendor-neutral).

Connects to whatever camera ONVIF_HOST/PORT/USER/PASS point at, discovers its
PTZ capabilities, and exercises every workflow the camera advertises. For each
positioning move it polls GetStatus and verifies the MoveStatus transition
IDLE -> MOVING -> IDLE.

Assertions are vendor-neutral:
  * Absolute positioning is validated by REPEATABILITY (same command -> same
    readback) and DISTINCTNESS (different commands -> different readbacks),
    not by assuming the readback equals the commanded value -- cameras report
    position in whatever space they choose.
  * Zoom / continuous moves are validated adaptively (via MoveStatus if the
    camera reports it for that move type, otherwise via observed motion).
  * Workflows a camera does not advertise are skipped, not failed.

Run:  .venv/bin/python run_tests.py
"""
from __future__ import annotations

import time

from onvif_ptz import PTZClient

PRESET_TEST_NAME = "ONVIFTEST"
results = []  # (name, status, detail)  status in {"PASS","FAIL","SKIP"}


def record(name, passed, detail=""):
    results.append((name, "PASS" if passed else "FAIL", detail))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f"  --  {detail}" if detail else ""))


def skip(name, why):
    results.append((name, "SKIP", why))
    print(f"  [SKIP] {name}  --  {why}")


def fmt(p):
    if not p:
        return "None"
    z = f", zoom={p[2]:.3f}" if p[2] is not None else ""
    return f"(pan={p[0]:+.3f}, tilt={p[1]:+.3f}{z})"


def show_transition(obs, axis, label):
    seq = " -> ".join(obs.axis_sequence(axis))
    span = obs.samples[-1].t if obs.samples else 0
    print(f"      {label} MoveStatus[{axis}]: {seq}   ({len(obs.samples)} samples / {span:.1f}s)")


def near(a, b, tol=0.05):
    return abs(a - b) <= tol


def safe(fn, cam):
    try:
        fn(cam)
    except Exception as e:
        record(f"{fn.__name__} raised", False, f"{type(e).__name__}: {str(e)[:90]}")


# --------------------------------------------------------------------------

def test_get_status(cam):
    print("\n[1] GetStatus (baseline)")
    pt, z = cam.move_status()
    pos = cam.position()
    record("GetStatus returns position + MoveStatus",
           pt in ("IDLE", "MOVING") and pos[0] is not None,
           f"pos={fmt(pos)} moveStatus=(PanTilt={pt}, Zoom={z})")


def test_relative_move(cam):
    print("\n[2] RelativeMove + status transition")
    if not cam.caps.relative_pantilt:
        return skip("RelativeMove", "camera does not advertise relative pan/tilt")
    # Centre first so the step can't be clipped by a limit.
    if cam.caps.absolute_pantilt:
        cam.absolute_move(*cam.abs_pantilt(0.5, 0.5), 0.0)
        cam.poll_until_idle(axis="pantilt")
    start = cam.stable_position()
    dx, dy = cam.rel_translation(-0.30, -0.20)
    cam.relative_move(dx=dx, dy=dy)
    obs = cam.poll_until_idle(axis="pantilt")
    show_transition(obs, "pantilt", "RelativeMove")
    record("RelativeMove: IDLE->MOVING->IDLE", obs.transitioned("pantilt"),
           " -> ".join(obs.axis_sequence("pantilt")))
    end = obs.final_pos
    record("RelativeMove: position changed",
           bool(end and (abs(end[0] - start[0]) > 0.02 or abs(end[1] - start[1]) > 0.02)),
           f"{fmt(start)} -> {fmt(end)}")


def test_absolute_move(cam):
    print("\n[3] AbsoluteMove + status transition + repeatability")
    if not cam.caps.absolute_pantilt:
        return skip("AbsoluteMove", "camera does not advertise absolute pan/tilt")
    A = cam.abs_pantilt(0.60, 0.55)
    B = cam.abs_pantilt(0.30, 0.35)

    cam.absolute_move(*A, 0.0)
    obs = cam.poll_until_idle(axis="pantilt")
    show_transition(obs, "pantilt", "AbsoluteMove->A")
    record("AbsoluteMove: IDLE->MOVING->IDLE", obs.transitioned("pantilt"),
           " -> ".join(obs.axis_sequence("pantilt")))
    posA1 = cam.stable_position()

    cam.absolute_move(*B, 0.0)
    cam.poll_until_idle(axis="pantilt")
    posB = cam.stable_position()
    cam.absolute_move(*A, 0.0)
    cam.poll_until_idle(axis="pantilt")
    posA2 = cam.stable_position()

    record("AbsoluteMove: repeatable (same cmd -> same readback)",
           near(posA1[0], posA2[0], 0.05) and near(posA1[1], posA2[1], 0.05),
           f"A#1={fmt(posA1)} A#2={fmt(posA2)}")
    record("AbsoluteMove: distinct targets -> distinct readbacks",
           abs(posA2[0] - posB[0]) > 0.05 or abs(posA2[1] - posB[1]) > 0.05,
           f"A={fmt(posA2)} B={fmt(posB)}")


def test_zoom(cam):
    print("\n[4] Zoom AbsoluteMove + status transition")
    if not cam.caps.absolute_zoom:
        return skip("Zoom AbsoluteMove", "camera does not advertise absolute zoom")
    center = cam.abs_pantilt(0.5, 0.5)
    z_in = cam.zoom_target(0.5)
    z0 = cam.position()[2]
    cam.absolute_move(*center, z_in)
    obs = cam.poll_until_idle(axis="zoom", timeout=30)
    show_transition(obs, "zoom", "ZoomIn")
    # Validate via MoveStatus if the camera reports it for zoom; otherwise via
    # the reported zoom position changing.
    z1 = cam.stable_position()[2]
    moved_by_status = obs.reached_moving("zoom") and obs.returned_idle("zoom")
    moved_by_pos = (z0 is not None and z1 is not None and abs(z1 - z0) > 0.02)
    record("Zoom: motor actuated (MoveStatus transition or position change)",
           moved_by_status or moved_by_pos,
           f"statusSeq={' -> '.join(obs.axis_sequence('zoom'))} zoom {z0}->{z1}")
    if z1 is None or (z0 is not None and abs(z1 - z0) < 0.02 and not moved_by_pos):
        print("      NOTE: camera does not report a changing zoom position readback")
    cam.absolute_move(*center, cam.zoom_target(0.0))  # zoom back out
    cam.poll_until_idle(axis="zoom", timeout=30)


def test_continuous_move(cam):
    print("\n[5] ContinuousMove + Stop")
    if not cam.caps.continuous_pantilt:
        return skip("ContinuousMove", "camera does not advertise continuous pan/tilt")
    if cam.caps.absolute_pantilt:
        cam.absolute_move(*cam.abs_pantilt(0.5, 0.5), 0.0)
        cam.poll_until_idle(axis="pantilt")
    p0 = cam.stable_position()

    vx, vy = cam.velocity(0.8, 0.0)
    cam.continuous_move(vx=vx, vy=vy)
    saw_moving = False
    t0 = time.time()
    while time.time() - t0 < 1.5:
        if cam.move_status()[0] == "MOVING":
            saw_moving = True
        time.sleep(0.1)
    p_during = cam.position()
    cam.stop()
    p1 = cam.stable_position()

    record("ContinuousMove: camera physically pans",
           abs(p_during[0] - p0[0]) > 0.02 or abs(p_during[1] - p0[1]) > 0.02,
           f"{fmt(p0)} -> {fmt(p_during)}")
    record("Stop: motion halts (position stops changing)",
           abs(cam.position()[0] - p1[0]) < 0.02, f"stopped near {fmt(p1)}")
    print(f"      NOTE: MoveStatus reported MOVING during continuous move? {saw_moving} "
          f"(some cameras only track MoveStatus for absolute/relative/preset/home moves)")


def test_presets(cam):
    print("\n[6] Preset lifecycle (Set/Get/Goto/Remove)")
    if not cam.caps.absolute_pantilt:
        return skip("Preset lifecycle", "needs absolute pan/tilt to verify positions")
    if cam.caps.max_presets == 0:
        return skip("Preset lifecycle", "camera advertises 0 presets")

    for p in cam.get_presets():
        if getattr(p, "Name", None) == PRESET_TEST_NAME:
            cam.remove_preset(p.token)
    before = len(cam.get_presets())

    cam.absolute_move(*cam.abs_pantilt(0.30, 0.35), 0.0)
    cam.poll_until_idle(axis="pantilt")
    saved = cam.stable_position()
    token = cam.set_preset(PRESET_TEST_NAME)
    record("SetPreset: returned token", bool(token), f"token={token!r}")

    presets = cam.get_presets()
    record("GetPresets: new preset present",
           any(p.token == token for p in presets), f"count {before} -> {len(presets)}")

    cam.absolute_move(*cam.abs_pantilt(0.70, 0.65), 0.0)
    cam.poll_until_idle(axis="pantilt")
    cam.goto_preset(token)
    obs = cam.poll_until_idle(axis="pantilt")
    show_transition(obs, "pantilt", "GotoPreset")
    record("GotoPreset: IDLE->MOVING->IDLE", obs.transitioned("pantilt"),
           " -> ".join(obs.axis_sequence("pantilt")))
    end = cam.stable_position()
    record("GotoPreset: returned to saved position",
           near(end[0], saved[0], 0.06) and near(end[1], saved[1], 0.06),
           f"saved={fmt(saved)} actual={fmt(end)}")

    cam.remove_preset(token)
    record("RemovePreset: preset removed",
           all(p.token != token for p in cam.get_presets()))


def test_home(cam):
    print("\n[7] SetHomePosition -> GotoHomePosition round-trip")
    if not cam.caps.home_supported:
        return skip("Home round-trip", "camera does not advertise HomeSupported")
    if not cam.caps.absolute_pantilt:
        return skip("Home round-trip", "needs absolute pan/tilt to verify position")

    cam.absolute_move(*cam.abs_pantilt(0.65, 0.60), 0.0)
    cam.poll_until_idle(axis="pantilt")
    home = cam.stable_position()
    try:
        cam.set_home()
        record("SetHomePosition: accepted", True, f"home={fmt(home)}")
    except Exception as e:
        # Some cameras support GotoHome against a fixed factory home but reject
        # SetHome; fall back to just exercising GotoHome.
        print(f"      SetHomePosition not supported ({str(e)[:60]}); testing GotoHome only")

    cam.absolute_move(*cam.abs_pantilt(0.35, 0.40), 0.0)
    cam.poll_until_idle(axis="pantilt")
    cam.goto_home()
    obs = cam.poll_until_idle(axis="pantilt")
    show_transition(obs, "pantilt", "GotoHome")
    record("GotoHomePosition: IDLE->MOVING->IDLE", obs.transitioned("pantilt"),
           " -> ".join(obs.axis_sequence("pantilt")))


def print_capabilities(cam):
    c = cam.caps
    print("\n=== Discovered PTZ capabilities ===")
    print(f"  absolute pan/tilt : {c.absolute_pantilt}   range={c.abs_pantilt_range}")
    print(f"  relative pan/tilt : {c.relative_pantilt}   range={c.rel_pantilt_range}")
    print(f"  continuous p/t    : {c.continuous_pantilt}   range={c.cont_pantilt_range}")
    print(f"  absolute zoom     : {c.absolute_zoom}   range={c.abs_zoom_range}")
    print(f"  home supported    : {c.home_supported}")
    print(f"  max presets       : {c.max_presets}")


def main():
    print("=" * 70)
    print("ONVIF PTZ workflow test run")
    print("=" * 70)
    cam = PTZClient()
    info = cam.devicemgmt.GetDeviceInformation()
    print(f"Device : {info.Manufacturer} {info.Model} fw={info.FirmwareVersion}")
    print(f"Profile: {cam.profile.Name} ({cam.token})")

    if not cam.has_ptz:
        print("\n!! Camera exposes no PTZ node -- only GetStatus-style tests apply.")
        print("   (This is expected for fixed/non-PTZ ONVIF cameras.)")
        return 0

    print_capabilities(cam)
    original = cam.position()

    for t in (test_get_status, test_relative_move, test_absolute_move, test_zoom,
              test_continuous_move, test_presets, test_home):
        safe(t, cam)

    print("\n[*] Restoring original position ...")
    if cam.caps.absolute_pantilt and original and original[0] is not None:
        cam.absolute_move(original[0], original[1], original[2] or 0.0)
        cam.poll_until_idle(axis="pantilt")

    print("\n" + "=" * 70)
    passed = sum(1 for _, s, _ in results if s == "PASS")
    failed = sum(1 for _, s, _ in results if s == "FAIL")
    skipped = sum(1 for _, s, _ in results if s == "SKIP")
    print(f"SUMMARY: {passed} passed, {failed} failed, {skipped} skipped")
    for name, s, _ in results:
        if s == "FAIL":
            print(f"   FAILED: {name}")
    print("=" * 70)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
