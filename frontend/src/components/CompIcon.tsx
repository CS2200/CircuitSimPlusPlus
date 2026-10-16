import { compPins, compSize, compSpec, type PinSpec } from "../editor/catalog";
import { probePath, chipPath, bubblePaths, gateShape } from "../editor/shapes";
import type { PathCmd } from "../render/renderer";

/**
 * Palette component glyph (frontend/UI_OVERHAUL.md §7): a small SVG of the
 * component as it looks on the canvas — gate bodies come from the real
 * `gateShape` geometry and pin stubs from the catalog's pin specs, so the
 * sidebar is a faithful miniature of what gets placed. Drawn in
 * `currentColor` so it inherits the button's text color in every theme.
 *
 * Box families carry a short glyph (+, ×, RAM, …); a few types get bespoke
 * silhouettes (clock waveform, probe pulse, LED, subcircuit module).
 */

/** PathCmd[] → SVG `d` (same curve set the canvas renderer speaks). */
function d(cmds: readonly PathCmd[]): string {
  return cmds
    .map((c) => {
      switch (c.t) {
        case "M":
          return `M${c.x} ${c.y}`;
        case "L":
          return `L${c.x} ${c.y}`;
        case "Q":
          return `Q${c.cx} ${c.cy} ${c.x} ${c.y}`;
        case "Z":
          return "Z";
      }
    })
    .join(" ");
}

/** Short glyph drawn inside box-family bodies. */
const GLYPHS: Readonly<Record<string, string>> = {
  "arith.adder": "+",
  "arith.subtractor": "\u2212",
  "arith.multiplier": "\u00d7",
  "arith.divider": "\u00f7",
  "arith.comparator": "=",
  "arith.negator": "~",
  "arith.shifter": "\u00ab",
  "arith.bit-extender": "EXT",
  "mem.register": "REG",
  "mem.ram": "RAM",
  "mem.rom": "ROM",
  "plexers.decoder": "DECODER",
  "wiring.constant": "1",
  "io.hexdisplay": "8",
  "misc.text": "T",
};

/** Outward stub direction for a pin (edge inferred from its position). */
function pinStub(p: PinSpec, w: number, h: number): { x2: number; y2: number } {
  const len = 0.5;
  if (p.dx <= 0.5) return { x2: p.dx - len, y2: p.dy };
  if (p.dx >= w - 0.5) return { x2: p.dx + len, y2: p.dy };
  if (p.dy <= 0.5) return { x2: p.dx, y2: p.dy - len };
  if (p.dy >= h - 0.5) return { x2: p.dx, y2: p.dy + len };
  return { x2: p.dx, y2: p.dy };
}

/** Glyph size: fit the box's height, shrink to fit its width. */
function fontSize(glyph: string, w: number, h: number): number {
  return Math.min(h * 0.6, (w * 1.9) / glyph.length);
}

const BOX_RX = 0.12;
/** Palette item glyph height in CSS px (rail tabs use a larger size). */
const RENDER_HEIGHT = 20;

export default function CompIcon({
  type,
  attrs = {},
  height = RENDER_HEIGHT,
}: {
  type: string;
  /** Type attrs that affect the silhouette (e.g. a pin's `isOutput`). */
  attrs?: Record<string, unknown>;
  /** Rendered height in CSS px (default 14; the rail uses a larger size). */
  height?: number;
}) {
  const { w, h } = compSize({ type, attrs }, []);
  const pins = compPins({ type, attrs }, []);
  const pad = 0.75;
  const vbW = w + 2 * pad;
  const vbH = h + 2 * pad;
  const shape = gateShape(type, 0, 0, w, h);
  const glyph = GLYPHS[type];
  const caption = compSpec(type).caption(attrs);

  return (
    <svg
      className="comp-icon"
      viewBox={`${-pad} ${-pad} ${vbW} ${vbH}`}
      width={(vbW / vbH) * height}
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.85}
        strokeWidth={0.14}
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {/* body */}
        {shape !== null ? (
          <>
            <path d={d(shape.body)} fill="currentColor" fillOpacity={0.08} />
            {shape.extra.map((cmds, i) => (
              <path key={i} d={d(cmds)} />
            ))}
            {bubblePaths(shape, []).map((cmds, i) => (
              <path key={i} d={d(cmds)} />
            ))}
          </>
        ) : type === "wiring.clock" ? (
          // square-wave source — no box, the waveform is the icon
          <path d="M0.15 1.25 L0.5 1.25 L0.5 0.75 L1.0 0.75 L1.0 1.25 L1.5 1.25 L1.5 0.75 L1.85 0.75" />
        ) : type === "io.led" ? (
          // LED dome + legs (UI_OVERHAUL §49) — same look as on canvas
          <>
            <circle
              cx={w / 2}
              cy={h / 2}
              r={Math.min(w, h) * 0.34}
              fill="currentColor"
              fillOpacity={0.3}
            />
            <path
              d={`M${w / 2 - 0.15} ${h / 2 + 0.26} L${w / 2 - 0.15} ${h} M${w / 2 + 0.15} ${
                h / 2 + 0.26
              } L${w / 2 + 0.15} ${h}`}
            />
          </>
        ) : type === "wiring.probe" ? (
          // the probe's pointed hexagon (UI_OVERHAUL §40) — same as on canvas
          <path d={d(probePath(0, 0, w, h))} fill="currentColor" fillOpacity={0.08} />
        ) : type === "mem.ram" || type === "mem.rom" ? (
          // chip body (UI_OVERHAUL §46) — same as on canvas
          <path d={d(chipPath(0, 0, w, h))} fill="currentColor" fillOpacity={0.08} />
        ) : type === "wiring.splitter" ? (
          // A bus rail with a tap per split pin (UI_OVERHAUL §46) — no box, so it
          // doesn't read as a mux.
          <>
            <path d={`M0.7 0.25 L0.7 ${h - 0.25}`} />
            {pins.map((p, i) =>
              p.name === "bus" ? (
                <path key={i} d={`M${p.dx} ${p.dy} L0.7 ${p.dy}`} />
              ) : (
                <path key={i} d={`M0.7 ${p.dy} L${p.dx} ${p.dy}`} />
              ),
            )}
          </>
        ) : (
          <>
            <rect
              x={0}
              y={0}
              width={w}
              height={h}
              rx={BOX_RX}
              fill="currentColor"
              fillOpacity={0.08}
            />
            {type === "subcircuit" && (
              // module look: an inset border
              <rect
                x={0.18}
                y={0.18}
                width={w - 0.36}
                height={h - 0.36}
                rx={BOX_RX}
                strokeOpacity={0.35}
              />
            )}
            {type === "io.button" && (
              <circle cx={w / 2} cy={h / 2} r={0.34} fill="currentColor" fillOpacity={0.2} />
            )}
            {glyph !== undefined && (
              <text
                x={w / 2}
                y={h / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fontSize(glyph, w, h)}
                fontFamily="ui-monospace, monospace"
                fontWeight={600}
                fill="currentColor"
                stroke="none"
                opacity={0.9}
              >
                {glyph}
              </text>
            )}
            {glyph === undefined &&
              type !== "wiring.probe" &&
              type !== "io.button" &&
              type !== "subcircuit" &&
              caption === "?" && (
                // unknown type marker
                <text
                  x={w / 2}
                  y={h / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={fontSize("?", w, h)}
                  fontFamily="ui-monospace, monospace"
                  fill="currentColor"
                  stroke="none"
                >
                  ?
                </text>
              )}
          </>
        )}

        {/* pins: outward stubs + terminal dots (canvas look) */}
        {pins.map((p, i) => {
          const { x2, y2 } = pinStub(p, w, h);
          return (
            <g key={i}>
              <line x1={p.dx} y1={p.dy} x2={x2} y2={y2} />
              <rect
                x={p.dx - 0.11}
                y={p.dy - 0.11}
                width={0.22}
                height={0.22}
                rx={0.03}
                fill="currentColor"
                fillOpacity={0.55}
                stroke="none"
              />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/** Representative glyph per palette group for the activity rail (UI_OVERHAUL §8). */
const GROUP_GLYPHS: Readonly<Record<string, string>> = {
  Gates: "gate.nand",
  Plexers: "plexers.mux",
  Arithmetic: "arith.adder",
  Memory: "mem.ram",
  "I/O": "io.led",
  Subcircuits: "subcircuit",
};

/** A bent wire with a junction dot — the Wiring group's rail glyph. */
function WireGroupGlyph({ height }: { height: number }) {
  return (
    <svg
      className="comp-icon"
      viewBox="-0.35 -0.25 3.2 2.6"
      width={(3.2 / 2.6) * height}
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.85}
        strokeWidth={0.18}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M0.15 1.95 H1.05 Q1.35 1.95 1.35 1.65 V0.55 Q1.35 0.25 1.65 0.25 H2.6" />
        <circle cx="1.35" cy="1.95" r="0.2" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}

/** Rail glyph for a palette group (Gates, Wiring, …). */
export function PaletteGroupIcon({ group, height = 26 }: { group: string; height?: number }) {
  if (group === "Wiring") return <WireGroupGlyph height={height} />;
  return <CompIcon type={GROUP_GLYPHS[group] ?? "subcircuit"} height={height} />;
}
