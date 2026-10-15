import type { ReactNode } from "react";

/**
 * Title-bar icons (UI_OVERHAUL.md §9): 16px stroke glyphs in `currentColor`,
 * sized for the top bar's icon buttons. Kept dependency-free (no icon
 * package) like the rest of the app's visuals.
 */

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="topbar-icon"
      viewBox="0 0 16 16"
      width={16}
      height={16}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function IconUndo() {
  return (
    <Glyph>
      <path d="M3 7l3.5-3.5M3 7l3.5 3.5M3 7h5.5c3 0 4.5 2.5 4.5 6.5" />
    </Glyph>
  );
}

export function IconRedo() {
  return (
    <Glyph>
      <path d="M13 7l-3.5-3.5M13 7l-3.5 3.5M13 7H7.5C4.5 7 3 9.5 3 13.5" />
    </Glyph>
  );
}

export function IconRotate() {
  return (
    <Glyph>
      <path d="M14 8a6 6 0 1 1-1.76-4.24L14 5.33" />
      <path d="M14 2v3.33h-3.33" />
    </Glyph>
  );
}

export function IconTrash() {
  return (
    <Glyph>
      <path d="M2.5 4.5h11" />
      <path d="M6.5 4.5V3.4a1.2 1.2 0 0 1 1.2-1.2h.6a1.2 1.2 0 0 1 1.2 1.2v1.1" />
      <path d="M4.3 4.5l.7 8.4a1.2 1.2 0 0 0 1.2 1.1h3.6a1.2 1.2 0 0 0 1.2-1.1l.7-8.4" />
      <path d="M6.8 7v4.2M9.2 7v4.2" />
    </Glyph>
  );
}

export function IconSun() {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.3v1.6M8 13.1v1.6M1.3 8h1.6M13.1 8h1.6M3.26 3.26l1.13 1.13M11.61 11.61l1.13 1.13M12.74 3.26l-1.13 1.13M4.39 11.61l-1.13 1.13" />
    </Glyph>
  );
}

export function IconMoon() {
  return (
    <Glyph>
      <path d="M13.6 9.6A5.7 5.7 0 0 1 6.4 2.4a5.7 5.7 0 1 0 7.2 7.2Z" />
    </Glyph>
  );
}
