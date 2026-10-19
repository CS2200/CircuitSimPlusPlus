import type { ReactNode, SVGProps } from "react";

/**
 * Minimal inline SVG icons for the top bar (VSCode-style chrome).
 * All icons stroke with `currentColor`, sit on a 20×20 grid, and are
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

/** Waveform viewer (UI_OVERHAUL §89): a two-bit step trace. */
export function WaveIcon() {
  return (
    <Svg>
      <path d="M2.5 8.5h3v-4h5v4h5" />
      <path d="M2.5 14.5h5v-3h4v3h4" />
    </Svg>
  );
}

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
