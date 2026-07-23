#!/usr/bin/env python3
"""Probe an ONVIF camera: verify compatibility and discover capabilities/profiles/PTZ."""
import sys
from onvif import ONVIFCamera

# Connection config comes from env vars (see onvif_ptz._load_dotenv / README):
#   ONVIF_HOST, ONVIF_PORT, ONVIF_USER, ONVIF_PASS
from onvif_ptz import DEFAULT_HOST as HOST, DEFAULT_PORT as PORT, \
    DEFAULT_USER as USER, DEFAULT_PASS as PASS


def main():
    print(f"Connecting to {HOST}:{PORT} ...")
    cam = ONVIFCamera(HOST, PORT, USER, PASS)

    # --- Device information ---
    dev = cam.create_devicemgmt_service()
    info = dev.GetDeviceInformation()
    print("\n=== GetDeviceInformation ===")
    for k in ("Manufacturer", "Model", "FirmwareVersion", "SerialNumber", "HardwareId"):
        print(f"  {k}: {getattr(info, k, None)}")

    # --- Services / capabilities ---
    print("\n=== GetServices ===")
    try:
        services = dev.GetServices({"IncludeCapability": False})
        for s in services:
            print(f"  {s.Namespace} -> {s.XAddr}")
    except Exception as e:
        print("  GetServices failed:", e)

    print("\n=== GetCapabilities ===")
    caps = dev.GetCapabilities({"Category": "All"})
    print("  Has PTZ:", bool(getattr(caps, "PTZ", None)))
    print("  Has Media:", bool(getattr(caps, "Media", None)))
    print("  Has Events:", bool(getattr(caps, "Events", None)))
    if getattr(caps, "PTZ", None):
        print("  PTZ XAddr:", caps.PTZ.XAddr)

    # --- Media profiles ---
    media = cam.create_media_service()
    profiles = media.GetProfiles()
    print(f"\n=== GetProfiles ({len(profiles)}) ===")
    for p in profiles:
        ptz_cfg = getattr(p, "PTZConfiguration", None)
        print(f"  token={p.token!r} name={getattr(p,'Name',None)!r} "
              f"PTZConfig={'yes' if ptz_cfg else 'no'}")

    # --- PTZ service basic check ---
    if getattr(caps, "PTZ", None):
        ptz = cam.create_ptz_service()
        print("\n=== PTZ configurations ===")
        for cfg in ptz.GetConfigurations():
            print(f"  token={cfg.token!r} name={getattr(cfg,'Name',None)!r}")
        # nodes describe supported spaces / preset limits
        print("\n=== PTZ nodes ===")
        for node in ptz.GetNodes():
            print(f"  node token={node.token!r} "
                  f"MaxPresets={getattr(node,'MaximumNumberOfPresets',None)} "
                  f"HomeSupported={getattr(node,'HomeSupported',None)}")
    else:
        print("\n!! Camera reports NO PTZ capability")

    print("\nProbe complete.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        sys.exit(1)
