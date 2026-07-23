import type { Capabilities } from "./types";

export type CapabilityItem = {
  label: string;
  short: string;
  on: boolean;
  value: string; // human-readable state, e.g. "Supported" / "Not supported" / "300 max"
};

/**
 * The full set of PTZ capabilities we probe, in display order. Both the
 * supported and the missing ones are returned so the UI can show exactly what
 * the camera does and does not advertise.
 */
export function capabilityList(c: Capabilities): CapabilityItem[] {
  const yn = (on: boolean) => (on ? "Supported" : "Not supported");
  return [
    { label: "Absolute Pan/Tilt", short: "Absolute P/T", on: c.absolutePanTilt, value: yn(c.absolutePanTilt) },
    { label: "Relative Pan/Tilt", short: "Relative P/T", on: c.relativePanTilt, value: yn(c.relativePanTilt) },
    { label: "Continuous Pan/Tilt", short: "Continuous P/T", on: c.continuousPanTilt, value: yn(c.continuousPanTilt) },
    { label: "Absolute Zoom", short: "Absolute zoom", on: c.absoluteZoom, value: yn(c.absoluteZoom) },
    { label: "Relative Zoom", short: "Relative zoom", on: c.relativeZoom, value: yn(c.relativeZoom) },
    { label: "Continuous Zoom", short: "Continuous zoom", on: c.continuousZoom, value: yn(c.continuousZoom) },
    { label: "Home Position", short: "Home", on: c.homeSupported, value: yn(c.homeSupported) },
    {
      label: "Presets",
      short: "Presets",
      on: c.maxPresets > 0,
      value: c.maxPresets > 0 ? `${c.maxPresets} max` : "Not supported",
    },
  ];
}
