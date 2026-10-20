import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { resolveTheme, type Theme } from "../render/theme";
import type { SimController } from "../sim/controller";
import {
  bitLaneIndices,
  extractBit,
  isBus,
  projectSamples,
  stepSegments,
  valueAt,
  valueBits,
  waveText,
  type PlacedSample,
  type WaveSignal,
} from "../sim/waveform";
import { wireValueState } from "../lib/value";
import type { WireValue } from "../ipc/types";

/**
 * Waveform viewer (UI_OVERHAUL §89): a full-view trace of the running sim.
 *
 * It draws what the engine already streams — no new IPC.  `SimController.waves`
 * records every net, one sample per cycle, from the *pre-merge* diff tap, so a
 * trace is complete even at speed; this view never asks the engine for anything
 * it is not already sending.
 *
 * Rows: every named part (probe/register/RAM/ROM) to start with, plus whatever
 * was selected on the canvas ("Add selection"), plus per-bit expansion for a
 * bus.  The axis is **cycles** — the model the course reasons in — and the
 * colours are the canvas's own (`theme.wire[state]`), so a signal is the same
 * colour in the trace as it is on the schematic (§35).
 */

/** Minimum row height; rows grow into the panel (see `laneH`). */
const LANE_H = 22;
/** Ceiling for that growth: generous enough to read, not a stretched ruler. */
const LANE_H_MAX = 64;
const GUTTER = 196;
const PAD_TOP = 8;
const AXIS_H = 18;

interface Row {
  signal: WaveSignal;
  /** Set when this row is one bit of a bus (the parent's key + bit index). */
  bit?: number;
  parent?: string;
}

export default function WaveformView({
  sim,
  defaults,
  picked,
  circuitLabel,
  onClose,
  onNotify,
}: {
  sim: SimController;
  /** What a fresh trace opens with: the named parts plus every clock (App derives it). */
  defaults: WaveSignal[];
  /** Signals the canvas selection resolves to right now (App resolves them). */
  picked: WaveSignal[];
  circuitLabel: string;
  onClose: () => void;
  onNotify?: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<Row[]>(() => defaults.map((signal) => ({ signal })));
  const [pxPerCycle, setPxPerCycle] = useState(6);
  const [origin, setOrigin] = useState(0);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<{ cycle: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  /** True once the user has zoomed or panned by hand, so Fit stops re-applying. */
  const [manual, setManual] = useState(false);
  const themeRef = useRef<Theme | null>(null);

  // Redraw on every applied frame (the store bumps ≤ once per frame while
  // running) — reading the recorder directly, like the canvas reads netValues.
  const version = useSyncExternalStore(sim.store.subscribe, () => sim.store.getVersion());
  /**
   * The axis: `x` is a fractional cycle, so a signal that moves twice inside one
   * cycle (the clock) is drawn as it really is.  Several events share a cycle
   * number — the mock says so outright (`cycle = tick / 2`) — so the cycle count
   * alone cannot place them.
   */
  const tb = useMemo(() => sim.waves.timebase(), [sim.waves, version]);
  const span = useMemo(() => {
    const ts = sim.waves.timeSpan;
    if (ts === null) return null;
    return {
      first: tb.x(ts.firstT, ts.firstCycle),
      last: tb.x(ts.lastT, ts.lastCycle),
    };
  }, [tb, sim.waves, version]);

  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setSize({
        w: Math.max(320, Math.round(rect.width)),
        h: Math.max(160, Math.round(rect.height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // Leaving the app must drop the cursor: `mouseleave` on the canvas does not
    // fire when the window itself goes away, and a frozen readout then claims to
    // be about a cycle the mouse is nowhere near.
    const onBlur = () => setCursor(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  /** Rows to draw: an expanded bus contributes one row per bit, MSB first. */
  const drawRows = useMemo(() => {
    const out: Row[] = [];
    for (const row of rows) {
      out.push(row);
      if (expanded.has(row.signal.key)) {
        const placed = projectSamples(sim.waves.samples(row.signal.net), tb);
        const sample = valueAt(placed, placed[placed.length - 1]?.x ?? 0);
        const bits = Math.min(
          32,
          row.signal.bits ?? valueBits(sample?.val ?? { v: "0", x: "0", z: "0" }),
        );
        for (const bit of bitLaneIndices(bits)) {
          out.push({ signal: row.signal, bit, parent: row.signal.key });
        }
      }
    }
    return out;
  }, [rows, expanded, sim.waves, tb, version]);

  /**
   * Fit the whole recorded run into the canvas — the *whole* width, so a short
   * trace is not a sliver at the left with dead space beside it. The ceiling is
   * generous (a shallow run is readable zoomed in, and Follow keeps the live
   * edge pinned when it matters).
   */
  const fit = useCallback(() => {
    if (span === null) return;
    const width = Math.max(64, size.w - GUTTER);
    const cycles = Math.max(1, span.last - span.first + 1);
    const px = Math.max(0.25, Math.min(400, width / cycles));
    setPxPerCycle(px);
    setOrigin(follow ? span.last - width / px : 0);
    setManual(false);
  }, [span, size.w, follow]);

  /**
   * Fit **once** — when the trace first has something to show, or when the panel
   * is resized — and never again for a growing run.  Re-fitting on every new
   * sample is what made the trace condense cycle by cycle and the old cycles
   * creep leftwards: the scope model is a fixed width with the window sliding
   * (Follow), or an explicit Fit.
   */
  const fitted = useRef(false);
  const fittedWidth = useRef(0);
  useEffect(() => {
    if (manual || span === null) return;
    if (!fitted.current || fittedWidth.current !== size.w) {
      fit();
      fitted.current = true;
      fittedWidth.current = size.w;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [span, size.w, manual]);

  // Follow the live edge while the sim runs (a scope's right-anchored view).
  useEffect(() => {
    if (!follow || span === null) return;
    const width = size.w - GUTTER;
    setOrigin(span.last - width / pxPerCycle);
  }, [follow, span, pxPerCycle, size.w]);

  /**
   * Lane height: a scope's constant row would leave two signals as a sliver at
   * the top of a full-height panel, so the rows grow into the space (bounded —
   * a 40px lane is already generous for one bit).
   */
  const laneH = Math.max(
    LANE_H,
    Math.min(LANE_H_MAX, Math.floor((size.h - AXIS_H - PAD_TOP) / Math.max(1, drawRows.length))),
  );

  /**
   * The canvas is the whole signal list, not just what fits: rows outgrow the
   * panel and the wrapper scrolls to reach them.  A trace you cannot scroll is a
   * trace whose lower half you cannot see.
   */
  const contentH = Math.max(size.h, PAD_TOP + drawRows.length * laneH + AXIS_H);

  /**
   * The recorded domain is `[0, last]` — nothing outside it was ever probed, so
   * nothing outside it is shown.  `origin` is clamped into it from one place, so
   * panning, zooming, Follow and the scrollbar cannot leave the data.
   */
  const domainLast = span?.last ?? 0;
  const laneWidth = Math.max(64, size.w - GUTTER);
  const visibleCycles = laneWidth / pxPerCycle;
  const maxOrigin = Math.max(0, domainLast - visibleCycles);
  useEffect(() => {
    // React bails out when the value is unchanged, so this is free per render.
    setOrigin((o) => Math.min(Math.max(0, o), maxOrigin));
  }, [maxOrigin]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const theme = themeRef.current ?? (themeRef.current = resolveTheme(canvas));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(contentH * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, contentH);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, size.w, contentH);

    const laneW = size.w - GUTTER;
    const x = (cycle: number) => GUTTER + (cycle - origin) * pxPerCycle;
    const visibleTo = origin + laneW / pxPerCycle;
    const first = Math.max(0, Math.floor(origin));
    const last = Math.ceil(visibleTo);

    /** Where the recorded data ends on screen: nothing is drawn past it. */
    const dataRight = span === null ? size.w : Math.min(size.w, x(span.last));

    // The name column is its own pane: an opaque backdrop, so it reads as the
    // fixed layer above the waves rather than as a translucent part of them.
    ctx.fillStyle = theme.panel;
    ctx.fillRect(0, 0, GUTTER, contentH);
    // …and the space past the last recorded cycle is marked as unrecorded rather
    // than left looking like a stretch of time in which nothing happened.
    if (dataRight < size.w) {
      ctx.fillStyle = theme.panel;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(dataRight, 0, size.w - dataRight, contentH);
      ctx.globalAlpha = 1;
    }

    // Cycle gridlines: a step that keeps labels readable at any zoom.
    const target = 90;
    const stepCandidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    const gridStep =
      stepCandidates.find((s) => s * pxPerCycle >= target) ??
      stepCandidates[stepCandidates.length - 1];
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    const lastCycle = span === null ? last : Math.min(last, Math.floor(span.last));
    for (let c = Math.ceil(first / gridStep) * gridStep; c <= lastCycle; c += gridStep) {
      const gx = x(c);
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(gx) + 0.5, 0);
      ctx.lineTo(Math.round(gx) + 0.5, contentH - AXIS_H);
      ctx.stroke();
      if (gx < size.w - 14) {
        ctx.fillStyle = theme.textDim;
        ctx.textAlign = "center";
        ctx.fillText(String(c), gx, contentH - AXIS_H / 2);
      }
    }

    // Lanes.
    ctx.textAlign = "left";
    drawRows.forEach((row, i) => {
      const yTop = PAD_TOP + i * laneH;
      if (yTop > contentH - AXIS_H) return;
      const mid = yTop + laneH / 2;
      const high = yTop + 5;
      const low = yTop + laneH - 5;
      const placed = projectSamples(sim.waves.samples(row.signal.net), tb);

      const latest = placed[placed.length - 1]?.val;
      // Width from the document where it is known, so a 1-bit clock whose core
      // reports a wide mask is not mistaken for a bus, and a 16-bit register pads
      // to four hex digits rather than to whatever mask arrived.
      const rowBits =
        row.bit !== undefined
          ? 1
          : (row.signal.bits ?? Math.max(1, bitsOf(latest ?? { v: "0", x: "0", z: "0" })));
      const busRow = row.bit === undefined && isBus(row.signal, latest);

      // Gutter: label + the value under the cursor.
      const atCursor = cursor === null ? null : rowValueAt(row, placed, cursor.cycle);

      ctx.fillStyle = row.bit !== undefined ? theme.textDim : theme.text;
      const indent = row.bit !== undefined ? 12 : 0;
      const label = row.bit !== undefined ? `[${row.bit}]` : row.signal.label;
      ctx.fillText(clip(label, 17), 6 + indent, mid);
      if (atCursor !== null) {
        ctx.fillStyle = theme.textDim;
        const text = waveText(atCursor.val, rowBits);
        ctx.fillText(text, GUTTER - 12 - ctx.measureText(text).width, mid);
      }

      // The trace.  A one-bit signal is a LEVEL that holds and then edges to the
      // next level.  A bus is a VALUE that holds, so it is drawn as a bar
      // carrying that value: giving a multi-bit signal a high/low level is simply
      // wrong — every bus would look like the same flat line whatever it held,
      // which is what "condensed into one line" was.
      // Buses are told apart by hue, like on the canvas — a stable one per net,
      // and X/Z always read as X/Z whatever the hue would be.
      const busHue = theme.bus[Math.abs(row.signal.net) % theme.bus.length] ?? theme.wire.high;
      const boxUp = mid - 8;
      const boxDown = mid + 8;

      const segs = stepSegments(placed, first, last);
      let prevY: number | null = null;
      let prevText: string | null = null;
      for (const seg of segs) {
        const x0 = Math.max(GUTTER, x(seg.from));
        if (x0 >= dataRight) continue;
        let x1 = Math.min(dataRight, x(seg.to));
        if (x1 < x0) continue;
        // A state change is at least a pixel wide: at a zoom where a clock's half
        // cycle is sub-pixel, dropping it would show a flat line instead of a
        // toggle.  One pixel of "something happened here" is the honest picture.
        if (x1 - x0 < 1) x1 = Math.min(dataRight, x0 + 1);
        const state = wireValueState(seg.val);
        const known = state === "high" || state === "low";
        const y = busRow
          ? mid
          : state === "high"
            ? high
            : state === "low" || state === "disconnected"
              ? low
              : mid;
        const text = waveText(seg.val, row.bit !== undefined ? 1 : rowBits);
        ctx.strokeStyle = busRow
          ? state === "x"
            ? theme.wire.x
            : state === "z"
              ? theme.wire.z
              : busHue
          : theme.wire[state];
        ctx.lineWidth = busRow || known ? 1.6 : 1.2;
        ctx.beginPath();
        if (busRow) {
          // The bar (top and bottom), with a change marker where the value
          // becomes a different one: the reader has to see a new value rather
          // than a longer bar.
          if (prevText !== null && prevText !== text) {
            ctx.moveTo(Math.round(x0) + 0.5, boxUp);
            ctx.lineTo(Math.round(x0) + 0.5, boxDown);
          }
          ctx.moveTo(x0, boxUp);
          ctx.lineTo(x1, boxUp);
          ctx.moveTo(x0, boxDown);
          ctx.lineTo(x1, boxDown);
        } else if (prevY !== null && prevY !== y) {
          ctx.moveTo(Math.round(x0) + 0.5, prevY);
          ctx.lineTo(Math.round(x0) + 0.5, y);
          ctx.lineTo(x1, y);
        } else {
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
        }
        ctx.stroke();
        prevY = y;
        prevText = text;
        if (seg.contended === true) {
          ctx.strokeStyle = theme.violation;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0, busRow ? boxDown + 3 : y - 3);
          ctx.lineTo(x1, busRow ? boxDown + 3 : y - 3);
          ctx.stroke();
        }
        // The value itself: centred when it fits, clipped at the left when the
        // segment is merely narrow, and left to the gutter readout below that.
        const need = ctx.measureText(text).width + 8;
        if (busRow && x1 - x0 >= need) {
          ctx.fillStyle = theme.text;
          ctx.fillText(text, (x0 + x1) / 2 - ctx.measureText(text).width / 2, mid);
        } else if (busRow && x1 - x0 >= 34) {
          ctx.fillStyle = theme.textDim;
          ctx.fillText(clip(text, 10), x0 + 4, mid);
        }
      }
      if (placed.length === 0) {
        ctx.fillStyle = theme.textDim;
        ctx.fillText("no data", GUTTER + 8, mid);
      } else if (sim.waves.truncated.has(row.signal.net)) {
        ctx.fillStyle = theme.textDim;
        ctx.fillText("…", GUTTER - 6, mid);
      }

      // Row separator.
      ctx.strokeStyle = theme.panelBorder;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(0, yTop + laneH - 0.5);
      ctx.lineTo(size.w, yTop + laneH - 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // End of the signal list: the space below is not missing data, it is the
    // rest of the panel.  Turn it into the one instruction that matters.
    const lastLaneBottom = PAD_TOP + drawRows.length * laneH;
    if (size.h - lastLaneBottom - AXIS_H > 70) {
      ctx.strokeStyle = theme.panelBorder;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(GUTTER, lastLaneBottom + 0.5);
      ctx.lineTo(size.w, lastLaneBottom + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.textDim;
      ctx.textAlign = "left";
      ctx.fillText(
        "no more signals — select a wire or part on the canvas, then Add selection",
        GUTTER + 8,
        lastLaneBottom + 24,
      );
      ctx.textAlign = "center";
    }

    // Cursor, over everything — but only inside the lane area: a cursor left
    // behind outside it (the app lost focus with the mouse away) would draw a
    // rule through the signal labels.
    const cursorX = cursor === null ? null : Math.round(x(cursor.cycle)) + 0.5;
    if (
      cursor !== null &&
      cursor.cycle <= domainLast &&
      cursorX !== null &&
      cursorX >= GUTTER &&
      cursorX <= Math.min(size.w - 1, dataRight)
    ) {
      const cx = cursorX;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, contentH - AXIS_H);
      ctx.stroke();
    }

    // Gutter separator.
    ctx.strokeStyle = theme.panelBorder;
    ctx.beginPath();
    ctx.moveTo(GUTTER - 0.5, 0);
    ctx.lineTo(GUTTER - 0.5, contentH);
    ctx.stroke();

    function bitsOf(val: WireValue): number {
      return Math.max(4, valueBits(val));
    }
    function rowValueAt(row: Row, samples: readonly PlacedSample[], x: number) {
      const s = valueAt(samples, x);
      if (s === null) return null;
      return row.bit === undefined ? s : { val: extractBit(s.val, row.bit) };
    }
  }, [drawRows, size, contentH, pxPerCycle, origin, cursor, sim.waves, tb, version, span, laneH]);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls the rows
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      if (cx < GUTTER) return;
      const cycleAt = origin + (cx - GUTTER) / pxPerCycle;
      const next = Math.max(0.25, Math.min(200, pxPerCycle * Math.pow(1.0015, -e.deltaY)));
      setPxPerCycle(next);
      setOrigin(cycleAt - (cx - GUTTER) / next);
      setFollow(false);
      setManual(true);
    },
    [origin, pxPerCycle],
  );

  /** Drag horizontally to pan; vertical movement stays the wrapper's scroll. */
  const drag = useRef<{ x: number; origin: number } | null>(null);
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX - rect.left < GUTTER) return;
      drag.current = { x: e.clientX, origin };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [origin, pxPerCycle],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = drag.current;
      if (d === null) return;
      setOrigin(d.origin - (e.clientX - d.x) / pxPerCycle);
      setFollow(false);
      setManual(true);
    },
    [pxPerCycle],
  );
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  /**
   * The horizontal scrollbar: the whole recorded domain at a glance, with the
   * visible window as its thumb.  Without it a zoomed-in view gives no clue how
   * much run there is to the left or right, or that there is any.
   */
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scrub = useRef<{ x: number; origin: number } | null>(null);
  const domain = Math.max(1e-6, domainLast);
  const thumbWidth = Math.min(1, visibleCycles / domain);
  const thumbLeft = Math.min(1 - thumbWidth, Math.max(0, origin / domain));

  const onThumbDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      scrub.current = { x: e.clientX, origin };
      e.currentTarget.setPointerCapture(e.pointerId);
      setFollow(false);
      setManual(true);
    },
    [origin],
  );
  const onThumbMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = scrub.current;
      const track = trackRef.current;
      if (d === null || track === null) return;
      const width = track.getBoundingClientRect().width;
      if (width <= 0) return;
      setOrigin(d.origin + ((e.clientX - d.x) / width) * domainLast);
    },
    [domainLast],
  );
  const onThumbUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    scrub.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);
  /** A click on the track centres the window there. */
  const onTrackDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = (e.clientX - rect.left) / rect.width;
      setOrigin(frac * domainLast - visibleCycles / 2);
      setFollow(false);
      setManual(true);
    },
    [domainLast, visibleCycles],
  );

  const onMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      if (px < GUTTER) {
        setCursor(null);
        return;
      }
      setCursor({ cycle: origin + (px - GUTTER) / pxPerCycle, y: e.clientY - rect.top });
    },
    [origin, pxPerCycle],
  );

  const addPicked = useCallback(() => {
    setRows((cur) => {
      const have = new Set(cur.map((r) => r.signal.key));
      const next = [...cur];
      for (const s of picked) if (!have.has(s.key)) next.push({ signal: s });
      return next;
    });
    onNotify?.(`Added ${picked.length} selected signal${picked.length === 1 ? "" : "s"}`);
  }, [picked, onNotify]);

  // The axis is fractional (a cycle is several events), but a *readout* is a
  // cycle number: nobody wants 1.6041666666666665 in the bar.
  const current =
    cursor === null ? Math.floor(span?.last ?? 0) : Math.max(0, Math.floor(cursor.cycle));
  const spanText =
    span === null
      ? "no samples yet — run the sim"
      : `cycles ${Math.floor(span.first)}–${Math.floor(span.last)}`;

  return (
    <div className="wave-view">
      <div className="wave-bar">
        <strong>Waveform</strong>
        <span className="wave-bar-text">
          {circuitLabel} · {spanText} · {drawRows.length} row
          {drawRows.length === 1 ? "" : "s"}
        </span>
        <span className="wave-bar-spacer" />
        <span className="wave-bar-text">cycle {current}</span>
        <button
          className="secondary"
          title="Zoom out (Ctrl+wheel zooms at the cursor)"
          onClick={() => {
            setPxPerCycle((p) => Math.max(0.25, p / 1.5));
            setManual(true);
          }}
        >
          −
        </button>
        <button
          className="secondary"
          title="Zoom in (Ctrl+wheel zooms at the cursor)"
          onClick={() => {
            setPxPerCycle((p) => Math.min(400, p * 1.5));
            setManual(true);
          }}
        >
          +
        </button>
        <button className="secondary" onClick={fit}>
          Fit
        </button>
        <button
          className={follow ? "" : "secondary"}
          onClick={() => setFollow((f) => !f)}
          title="Keep the newest cycle at the right edge"
        >
          Follow
        </button>
        <button className="secondary" onClick={addPicked} disabled={picked.length === 0}>
          Add selection{picked.length > 0 ? ` (${picked.length})` : ""}
        </button>
        <button className="secondary" onClick={() => setRows([])} disabled={rows.length === 0}>
          Remove all
        </button>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="wave-canvas-wrap" ref={wrapRef}>
        {rows.length === 0 ? (
          <p className="wave-empty">
            No signals. Select a wire or a part on the canvas, then <em>Add selection</em> — named
            parts (probes, registers, RAM, ROM) appear here automatically once the circuit is
            loaded.
          </p>
        ) : null}
        <canvas
          ref={canvasRef}
          className="wave-canvas"
          style={{ width: size.w, height: contentH }}
          onWheel={onWheel}
          onMouseMove={onMove}
          onMouseLeave={() => setCursor(null)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            // Double-click a label to expand/collapse a bus, or drop the row.
            const rect = e.currentTarget.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const i = Math.floor((y - PAD_TOP) / laneH);
            const row = drawRows[i];
            if (row === undefined || row.bit !== undefined) return;
            const placed = projectSamples(sim.waves.samples(row.signal.net), tb);
            const bits = valueBits(
              valueAt(placed, placed[placed.length - 1]?.x ?? 0)?.val ?? { v: "0", x: "0", z: "0" },
            );
            if (e.clientX - rect.left < GUTTER && bits > 1) {
              setExpanded((cur) => {
                const next = new Set(cur);
                if (!next.delete(row.signal.key)) next.add(row.signal.key);
                return next;
              });
            }
          }}
        />
      </div>
      <div
        className="wave-scrollbar"
        ref={trackRef}
        title="The whole recorded run — drag the window, or click to jump"
        onPointerDown={onTrackDown}
      >
        <div
          className="wave-scrollbar-thumb"
          style={{ left: `${thumbLeft * 100}%`, width: `${thumbWidth * 100}%` }}
          onPointerDown={onThumbDown}
          onPointerMove={onThumbMove}
          onPointerUp={onThumbUp}
          onPointerCancel={onThumbUp}
        />
      </div>
    </div>
  );
}

/** One-line clip for the gutter (the canvas has no ellipsis). */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
