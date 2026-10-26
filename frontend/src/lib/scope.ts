/**
 * Scope colour for a circuit sheet (UI_OVERHAUL §77).
 *
 * A subcircuit sheet is a different SCOPE from the top level, and the editor says
 * so with a hue of its own: the sheet's tab, a frame around the canvas and a chip
 * in the status bar all use it. It is derived from the NAME, so it is stable
 * across runs (a sheet looks the same every time) and two definitions rarely look
 * alike.
 */
export function scopeHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  // Spread the residues around the wheel: names that differ by one character
  // (the "sub2", "sub3" the "+" tab makes) must not land on neighbouring hues.
  const spread = (h * 137.508) % 360;
  // …but never on RED (UI_OVERHAUL §98): red is the one colour that means "you
  // are inside a specific INSTANCE" (§77), and `sub2` (336°) and `sub5` (29°)
  // used to land there — a freshly made subcircuit looked like an instance view.
  // The wheel is squeezed into the band that excludes it.
  return Math.round(SAFE_FROM + (spread * (SAFE_TO - SAFE_FROM)) / 360);
}

/** The hue band a scope may use: orange round to purple, skipping red/magenta. */
export const SAFE_FROM = 42;
export const SAFE_TO = 292;
