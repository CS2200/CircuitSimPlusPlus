import type { ReactNode, SVGProps } from "react";

/**
 * Minimal inline SVG icons for the chrome (header, transport, palette, status
 * bar). All icons stroke with `currentColor`, sit on a 20×20 grid, and are
 * decorative (aria-hidden) — the buttons carry the accessible names.
 */

function Svg({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function UndoIcon() {
  return (
    <Svg>
      <path d="M7.5 4.5 4 8l3.5 3.5" />
      <path d="M4 8h8.5a4 4 0 0 1 0 8H10" />
    </Svg>
  );
}

export function RedoIcon() {
  return (
    <Svg>
      <path d="M12.5 4.5 16 8l-3.5 3.5" />
      <path d="M16 8H7.5a4 4 0 0 0 0 8H10" />
    </Svg>
  );
}

export function SunIcon() {
  return (
    <Svg>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 2.6v1.8M10 15.6v1.8M2.6 10h1.8M15.6 10h1.8M4.8 4.8l1.3 1.3M13.9 13.9l1.3 1.3M15.2 4.8l-1.3 1.3M6.1 13.9l-1.3 1.3" />
    </Svg>
  );
}

export function MoonIcon() {
  return (
    <Svg>
      <path d="M16.2 11.7A6.7 6.7 0 0 1 8.3 3.8a6.7 6.7 0 1 0 7.9 7.9z" />
    </Svg>
  );
}

/** The app mark: a logic gate seated in a rounded chip. */
export function AppLogoIcon() {
  return (
    <Svg width={22} height={22} strokeWidth={1.5}>
      <rect x="2.2" y="2.2" width="15.6" height="15.6" rx="3.8" />
      <path d="M5.4 7h2.4M5.4 13h2.4" />
      <path d="M7.8 6.2h2.6a3.8 3.8 0 0 1 0 7.6H7.8z" />
      <path d="M14.2 10h1.6" />
    </Svg>
  );
}

/** Clock with a counter-clockwise tail: "version history / restore". */
export function HistoryIcon() {
  return (
    <Svg>
      <path d="M2.5 10a7.5 7.5 0 1 0 7.5-7.5 8.1 8.1 0 0 0-5.6 2.3L2.5 6.7" />
      <path d="M2.5 2.5v4.2h4.2" />
      <path d="M10 5.8v4.2l3.3 1.7" />
    </Svg>
  );
}

/** Waveform viewer (UI_OVERHAUL §89): a square wave, not a clock face. */
export function WaveIcon() {
  return (
    <Svg>
      <path d="M2.5 14h3V6h4v8h4V6h3.5" />
    </Svg>
  );
}

/** Back to the circuit — the viewer's toggle leaves this in its place. */
export function CircuitIcon() {
  return (
    <Svg>
      <rect x="6.5" y="6.5" width="7" height="7" rx="1.2" />
      <path d="M8.5 6.5V3.5M11.5 6.5V3.5M8.5 13.5v3M11.5 13.5v3M6.5 8.5H3.5M6.5 11.5H3.5M13.5 8.5h3M13.5 11.5h3" />
    </Svg>
  );
}

/** Two slider rows — the Settings gear's quieter cousin. */
export function SettingsIcon() {
  return (
    <Svg>
      <path d="M3.4 6h5.4M12.6 6h4M3.4 14h3M10.4 14h6.2" />
      <circle cx="10.7" cy="6" r="1.9" />
      <circle cx="8.4" cy="14" r="1.9" />
    </Svg>
  );
}

export function RotateIcon() {
  return (
    <Svg>
      <path d="M15.6 10a5.6 5.6 0 1 1-1.7-4" />
      <path d="M15.9 2.9v3.4h-3.4" />
    </Svg>
  );
}

// ---- transport (UI_OVERHAUL §94) ----

/** Run: a filled triangle, the one solid mark in the transport. */
export function PlayIcon() {
  return (
    <Svg fill="currentColor" stroke="none">
      <path d="M6.6 4.6v10.8c0 .9 1 1.5 1.8 1l8.6-5.4c.7-.5.7-1.5 0-2L8.4 3.6c-.8-.5-1.8.1-1.8 1z" />
    </Svg>
  );
}

export function PauseIcon() {
  return (
    <Svg fill="currentColor" stroke="none">
      <rect x="5" y="4" width="3.8" height="12" rx="1.3" />
      <rect x="11.2" y="4" width="3.8" height="12" rx="1.3" />
    </Svg>
  );
}

/** Step one tick: a triangle up against a stop. */
export function StepIcon() {
  return (
    <Svg fill="currentColor" stroke="none">
      <path d="M4.5 5.1v9.8c0 .8.9 1.3 1.6.9l7-4.9c.6-.4.6-1.3 0-1.7l-7-4.9c-.7-.5-1.6 0-1.6.8z" />
      <rect x="14.2" y="4.5" width="2.2" height="11" rx="1" />
    </Svg>
  );
}

/** Reset: back to the start, counter-clockwise. */
export function ResetIcon() {
  return (
    <Svg>
      <path d="M4.4 10.2a5.8 5.8 0 1 0 1.8-4.2" />
      <path d="M4.2 3.2v3.6h3.6" />
    </Svg>
  );
}

/** Run to a cycle: an arrow to a mark. */
export function RunToIcon() {
  return (
    <Svg>
      <path d="M3.5 10h9" />
      <path d="M9.5 6.5 13 10l-3.5 3.5" />
      <path d="M16 5v10" />
    </Svg>
  );
}

// ---- general chrome ----

export function SearchIcon() {
  return (
    <Svg>
      <circle cx="9" cy="9" r="5.2" />
      <path d="m13 13 4 4" />
    </Svg>
  );
}

export function CloseIcon() {
  return (
    <Svg>
      <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
    </Svg>
  );
}

export function PlusIcon() {
  return (
    <Svg>
      <path d="M10 4.5v11M4.5 10h11" />
    </Svg>
  );
}

export function MinusIcon() {
  return (
    <Svg>
      <path d="M4.5 10h11" />
    </Svg>
  );
}

export function CheckIcon() {
  return (
    <Svg strokeWidth={2}>
      <path d="m4.5 10.5 3.6 3.5 7.4-8" />
    </Svg>
  );
}

export function WarnIcon() {
  return (
    <Svg>
      <path d="M10 3.2 2.8 15.8h14.4z" />
      <path d="M10 8v3.6M10 13.6v.1" />
    </Svg>
  );
}

export function InfoIcon() {
  return (
    <Svg>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5M10 6.4v.1" />
    </Svg>
  );
}

/** A pointer: "select something" (the Inspector's empty state). */
export function CursorIcon() {
  return (
    <Svg>
      <path d="M5 3.5 15.5 9.6l-4.6 1.2-2.4 4.2z" />
    </Svg>
  );
}

export function ChevronDownIcon() {
  return (
    <Svg>
      <path d="m5.5 8 4.5 4.5L14.5 8" />
    </Svg>
  );
}
