"""
Pytest unit tests for ONVIF PTZ workflows -- vendor-neutral.

Point them at any ONVIF-compliant camera via env vars (or a .env file):
    ONVIF_HOST, ONVIF_PORT, ONVIF_USER, ONVIF_PASS

Each test either verifies a workflow or is skipped when the camera does not
advertise that capability. Assertions avoid vendor-specific numbers:
absolute positioning is checked by repeatability + distinctness rather than by
assuming the readback equals the commanded value.

Run:  .venv/bin/python -m pytest test_ptz.py -v
"""
import time

import pytest

from onvif_ptz import PTZClient

PRESET_NAME = "ONVIFTEST"


def near(a, b, tol=0.05):
    return abs(a - b) <= tol


@pytest.fixture(scope="module")
def cam():
    # PTZClient() reads ONVIF_HOST/PORT/USER/PASS from the env (or .env).
    c = PTZClient()
    yield c
    # Best-effort cleanup: drop any test preset, centre if possible.
    if c.has_ptz:
        try:
            for p in c.get_presets():
                if getattr(p, "Name", None) == PRESET_NAME:
                    c.remove_preset(p.token)
        except Exception:
            pass
        if c.caps.absolute_pantilt:
            c.absolute_move(*c.abs_pantilt(0.5, 0.5), 0.0)
            c.poll_until_idle(axis="pantilt")


@pytest.fixture
def ptz(cam):
    if not cam.has_ptz:
        pytest.skip("camera exposes no PTZ node")
    return cam


@pytest.fixture
def centered(ptz):
    if ptz.caps.absolute_pantilt:
        ptz.absolute_move(*ptz.abs_pantilt(0.5, 0.5), 0.0)
        ptz.poll_until_idle(axis="pantilt")
    return ptz


# --------------------------------------------------------------------------

def test_onvif_compatible(cam):
    info = cam.devicemgmt.GetDeviceInformation()
    assert info.Manufacturer and info.Model
    assert len(cam.profiles) >= 1


def test_get_status_reports_position_and_movestatus(ptz):
    st = ptz.get_status()
    assert st.Position.PanTilt is not None
    assert st.MoveStatus.PanTilt in ("IDLE", "MOVING")


def test_relative_move_transitions_idle(centered):
    if not centered.caps.relative_pantilt:
        pytest.skip("no relative pan/tilt")
    dx, dy = centered.rel_translation(-0.30, -0.20)
    start = centered.stable_position()
    centered.relative_move(dx=dx, dy=dy)
    obs = centered.poll_until_idle(axis="pantilt")
    assert obs.transitioned("pantilt"), obs.axis_sequence("pantilt")
    end = obs.final_pos
    assert abs(end[0] - start[0]) > 0.02 or abs(end[1] - start[1]) > 0.02


def test_absolute_move_transitions_and_is_repeatable(centered):
    if not centered.caps.absolute_pantilt:
        pytest.skip("no absolute pan/tilt")
    A = centered.abs_pantilt(0.60, 0.55)
    B = centered.abs_pantilt(0.30, 0.35)

    centered.absolute_move(*A, 0.0)
    obs = centered.poll_until_idle(axis="pantilt")
    assert obs.transitioned("pantilt"), obs.axis_sequence("pantilt")
    p1 = centered.stable_position()

    centered.absolute_move(*B, 0.0)
    centered.poll_until_idle(axis="pantilt")
    pB = centered.stable_position()
    centered.absolute_move(*A, 0.0)
    centered.poll_until_idle(axis="pantilt")
    p2 = centered.stable_position()

    # repeatable: same command -> same readback
    assert near(p1[0], p2[0]) and near(p1[1], p2[1]), (p1, p2)
    # distinct: different commands -> different readbacks
    assert abs(p2[0] - pB[0]) > 0.05 or abs(p2[1] - pB[1]) > 0.05, (p2, pB)


def test_zoom_move(centered):
    if not centered.caps.absolute_zoom:
        pytest.skip("no absolute zoom")
    center = centered.abs_pantilt(0.5, 0.5)
    z0 = centered.position()[2]
    centered.absolute_move(*center, centered.zoom_target(0.5))
    obs = centered.poll_until_idle(axis="zoom", timeout=30)
    z1 = centered.stable_position()[2]
    # Validated by a MoveStatus transition OR a change in reported zoom position
    # (cameras differ in which they expose).
    moved = (obs.reached_moving("zoom") and obs.returned_idle("zoom")) or \
            (z0 is not None and z1 is not None and abs(z1 - z0) > 0.02)
    assert moved, (obs.axis_sequence("zoom"), z0, z1)
    centered.absolute_move(*center, centered.zoom_target(0.0))
    centered.poll_until_idle(axis="zoom", timeout=30)


def test_continuous_move_and_stop(centered):
    if not centered.caps.continuous_pantilt:
        pytest.skip("no continuous pan/tilt")
    p0 = centered.stable_position()
    vx, vy = centered.velocity(0.8, 0.0)
    centered.continuous_move(vx=vx, vy=vy)
    time.sleep(1.2)
    p_during = centered.position()
    centered.stop()
    p1 = centered.stable_position()
    # Validated by observed motion (MoveStatus for continuous is optional in ONVIF).
    assert abs(p_during[0] - p0[0]) > 0.02 or abs(p_during[1] - p0[1]) > 0.02
    assert abs(centered.position()[0] - p1[0]) < 0.02  # it stopped


def test_preset_lifecycle(centered):
    if not centered.caps.absolute_pantilt or centered.caps.max_presets == 0:
        pytest.skip("presets/absolute pan/tilt not supported")
    for p in centered.get_presets():
        if getattr(p, "Name", None) == PRESET_NAME:
            centered.remove_preset(p.token)

    centered.absolute_move(*centered.abs_pantilt(0.30, 0.35), 0.0)
    centered.poll_until_idle(axis="pantilt")
    saved = centered.stable_position()
    token = centered.set_preset(PRESET_NAME)
    assert token

    assert any(p.token == token for p in centered.get_presets())

    centered.absolute_move(*centered.abs_pantilt(0.70, 0.65), 0.0)
    centered.poll_until_idle(axis="pantilt")
    centered.goto_preset(token)
    obs = centered.poll_until_idle(axis="pantilt")
    assert obs.transitioned("pantilt"), obs.axis_sequence("pantilt")
    end = centered.stable_position()
    assert near(end[0], saved[0], 0.06) and near(end[1], saved[1], 0.06), (saved, end)

    centered.remove_preset(token)
    assert all(p.token != token for p in centered.get_presets())


def test_home_round_trip(centered):
    if not centered.caps.home_supported or not centered.caps.absolute_pantilt:
        pytest.skip("home / absolute pan/tilt not supported")
    centered.absolute_move(*centered.abs_pantilt(0.65, 0.60), 0.0)
    centered.poll_until_idle(axis="pantilt")
    home = centered.stable_position()
    set_home_ok = True
    try:
        centered.set_home()
    except Exception:
        set_home_ok = False  # camera may only support a fixed factory home

    centered.absolute_move(*centered.abs_pantilt(0.35, 0.40), 0.0)
    centered.poll_until_idle(axis="pantilt")
    centered.goto_home()
    obs = centered.poll_until_idle(axis="pantilt")
    assert obs.transitioned("pantilt"), obs.axis_sequence("pantilt")
    if set_home_ok:
        end = centered.stable_position()
        assert near(end[0], home[0], 0.06) and near(end[1], home[1], 0.06), (home, end)
