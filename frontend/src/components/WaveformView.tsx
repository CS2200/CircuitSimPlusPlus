import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { resolveTheme } from "../render/theme";
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
import { MinusIcon, PlusIcon } from "./icons";

/**
 * Waveform viewer (UI_OVERHAUL §89; reworked §95): a full-view trace of the
 * running sim.
 *
 * It draws what the engine already streams — no new IPC. `SimController.waves`
 * records every change from the *pre-merge* diff tap, so a trace is complete
 * even at speed; this view never asks the engine for anything.
 *
 * The axis is **cycles** (fractional, so both edges of a clock show), with a
 * ruler pinned at the top. The view is a window `[origin, origin + visible)`
 * over the recorded run `[first, liveEnd]`, where `liveEnd` is half a tick past
 * the newest event — the newest value is in effect *now*, so it gets width
 * instead of being a zero-width sliver at the right edge.
 *
 * Moving through time: drag the lanes, scroll sideways (trackpad, Shift+wheel,
 * or a plain wheel when the rows all fit), the scrollbar, or ←/→ Home End.
 * Ctrl/⌘+wheel zooms at the pointer; −/+ and Fit in the bar. **Follow** keeps
 * the live edge in view while the sim runs; panning away turns it off, and
 * panning back to the end turns it on again.
 *
 * Each row's name column always shows a value: the one under the pointer, or
 * else the value at the right edge of the view (the live value while
 * following). Hover a row for its remove ×; a bus has a ▸ to expand its bits.
 */

const LANE_H = 30;
const LANE_H_MAX = 52;
const GUTTER = 220;
const RULER_H = 24;
/** Room under the last row for the "how to add / move" hint. */
const HINT_H = 44;
/** A fresh view shows about this many cycles across the lane area. */
const DEFAULT_VISIBLE_CYCLES = 12;
const MIN_PX = 0.25;
const MAX_PX = 400;
const ZOOM_STEP = 1.5;
const ZERO: WireValue = { v: "0", x: "0", z: "0" };
const MONO = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

interface Row {
  signal: WaveSignal;
  /** Set when this row is one bit of a bus (the parent's key + bit index). */
  bit?: number;
  parent?: string;
}

/** The current window, mirrored into a ref so event handlers never go stale. */
interface View {
  origin: number;
  px: number;
  laneW: number;
  domainStart: number;
  domainEnd: number;
  follow: boolean;
}

export default function WaveformView({
  sim,
  defaults,
  picked,
  add = null,
  watches,
  circuitLabel,
  onClose,
  onNotify,
}: {
  sim: SimController;
  /** What a fresh trace opens with: the named parts plus every clock (App derives it). */
  defaults: WaveSignal[];
  /** Signals the canvas selection resolves to right now (App resolves them). */
  picked: WaveSignal[];
  /** "Show in waveform" (§96): signals to add; a new `seq` is a new request. */
  add?: { signals: WaveSignal[]; seq: number } | null;
  /** Breakpoints on this sheet: net → the conditions that stop on it (§90). */
  watches: ReadonlyMap<number, readonly string[]>;
  circuitLabel: string;
  onClose: () => void;
  onNotify?: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<Row[]>(() => defaults.map((signal) => ({ signal })));
  /** Default rows the user removed: they must not come back on the next reload. */
  const removedRef = useRef(new Set<string>());

  /**
   * Keep the default rows current (§96). The viewer can open before the first
   * load (its defaults are then empty), and every reload hands out NEW net ids —
   * so a row keyed `n:main/acc` must take the fresh signal, and a named part that
   * appears later must be added. A row the user removed stays removed.
   */
  useEffect(() => {
    setRows((cur) => {
      const byKey = new Map(defaults.map((d) => [d.key, d]));
      let changed = false;
      const next = cur.map((r) => {
        const d = byKey.get(r.signal.key);
        if (
          d !== undefined &&
          (d.net !== r.signal.net || d.bits !== r.signal.bits || d.label !== r.signal.label)
        ) {
          changed = true;
          return { ...r, signal: d };
        }
        return r;
      });
      const have = new Set(next.map((r) => r.signal.key));
      for (const d of defaults) {
        if (!have.has(d.key) && !removedRef.current.has(d.key)) {
          next.push({ signal: d });
          changed = true;
        }
      }
      return changed ? next : cur;
    });
  }, [defaults]);

  // "Show in waveform": add the requested signals (once per request).
  const lastAddSeq = useRef(0);
  useEffect(() => {
    if (add === null || add.seq === lastAddSeq.current) return;
    lastAddSeq.current = add.seq;
    for (const sig of add.signals) removedRef.current.delete(sig.key);
    setRows((cur) => {
      const have = new Set(cur.map((r) => r.signal.key));
      const fresh = add.signals.filter((sig) => !have.has(sig.key));
      return fresh.length === 0 ? cur : [...cur, ...fresh.map((signal) => ({ signal }))];
    });
  }, [add]);
  /** Pixels per cycle once the user zoomed; null = the default window. */
  const [pxManual, setPxManual] = useState<number | null>(null);
  /** Left edge (in cycles) while NOT following. */
  const [originState, setOriginState] = useState(0);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState({ w: 800, h: 400 });

  // Redraw on every applied frame (the store bumps ≤ once per frame while
  // running) — reading the recorder directly, like the canvas reads netValues.
  const version = useSyncExternalStore(sim.store.subscribe, () => sim.store.getVersion());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates the mutable recorder
  const tb = useMemo(() => sim.waves.timebase(), [sim.waves, version]);
  const span = useMemo(() => {
    const ts = sim.waves.timeSpan;
    if (ts === null) return null;
    const first = tb.x(ts.firstT, ts.firstCycle);
    const lastEvent = tb.x(ts.lastT, ts.lastCycle);
    // The newest value holds until the next edge: half a cycle on a timed
    // axis (one tick), a whole cycle when the core only knows cycles.
    return { first, lastEvent, liveEnd: lastEvent + (tb.hasTime ? 0.5 : 1) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates the mutable recorder
  }, [tb, sim.waves, version]);
  /** Where the run stopped, if it did (§90). */
  const halted = sim.store.halted;

  // ---- the window ----
  const laneW = Math.max(64, size.w - GUTTER);
  const domainStart = span?.first ?? 0;
  const domainEnd = span?.liveEnd ?? 1;
  const domain = Math.max(1e-6, domainEnd - domainStart);
  const px = pxManual ?? clampPx(laneW / DEFAULT_VISIBLE_CYCLES);
  const visible = laneW / px;
  const maxOrigin = Math.max(domainStart, domainEnd - visible);
  const origin = follow ? maxOrigin : Math.min(maxOrigin, Math.max(domainStart, originState));

  const viewRef = useRef<View>({ origin, px, laneW, domainStart, domainEnd, follow });
  viewRef.current = { origin, px, laneW, domainStart, domainEnd, follow };

  /** Move the window's left edge; landing on the live end re-engages Follow. */
  const panTo = useCallback((next: number, atPx?: number) => {
    const v = viewRef.current;
    const p = atPx ?? v.px;
    const maxO = Math.max(v.domainStart, v.domainEnd - v.laneW / p);
    const o = Math.min(maxO, Math.max(v.domainStart, next));
    setOriginState(o);
    setFollow(o >= maxO - 1e-6);
  }, []);

  const panBy = useCallback((cycles: number) => panTo(viewRef.current.origin + cycles), [panTo]);

  /** Zoom to `nextPx`, keeping the cycle under `anchor` (lane px) where it is. */
  const zoomTo = useCallback(
    (nextPx: number, anchor?: number) => {
      const v = viewRef.current;
      const p = clampPx(nextPx);
      setPxManual(p);
      if (v.follow && anchor === undefined) return; // the live edge stays pinned
      const a = anchor ?? v.laneW / 2;
      panTo(v.origin + a / v.px - a / p, p);
    },
    [panTo],
  );

  const fit = useCallback(() => {
    const v = viewRef.current;
    setPxManual(clampPx(v.laneW / Math.max(1e-6, v.domainEnd - v.domainStart)));
    setOriginState(v.domainStart);
    setFollow(true);
  }, []);

  // ---- size ----
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

  // ---- keyboard: Escape closes; arrows / Home / End / ± / F move the view ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+J/K/R stay the transport's
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const v = viewRef.current;
      const page = v.laneW / v.px;
      let handled = true;
      if (e.key === "ArrowLeft") panBy(-page * (e.shiftKey ? 0.5 : 0.15));
      else if (e.key === "ArrowRight") panBy(page * (e.shiftKey ? 0.5 : 0.15));
      else if (e.key === "Home") panTo(v.domainStart);
      else if (e.key === "End") setFollow(true);
      else if (e.key === "+" || e.key === "=") zoomTo(v.px * ZOOM_STEP);
      else if (e.key === "-" || e.key === "_") zoomTo(v.px / ZOOM_STEP);
      else if (e.key === "f" || e.key === "F") fit();
      else handled = false;
      if (handled) {
        // Captured, so the (hidden) editor never rotates a selection on ←/→.
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Leaving the app must drop the cursor: `mouseleave` does not fire when the
    // window itself goes away, and a frozen readout would then lie.
    const onBlur = () => setCursor(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose, panBy, panTo, zoomTo, fit]);

  // ---- the wheel: sideways pans, Ctrl/⌘ zooms, plain wheel scrolls rows ----
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * scale;
      const dy = e.deltaY * scale;
      const v = viewRef.current;
      const rect = el.getBoundingClientRect();
      const lanePx = e.clientX - rect.left - GUTTER;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const anchor = lanePx >= 0 ? lanePx : undefined;
        zoomTo(v.px * Math.exp(-dy * 0.002), anchor ?? v.laneW / 2);
        return;
      }
      const sideways = e.shiftKey || Math.abs(dx) > Math.abs(dy);
      if (sideways) {
        e.preventDefault();
        panBy((e.shiftKey && dx === 0 ? dy : dx) / v.px);
        return;
      }
      // Vertical: scroll the rows when there are more than fit, else move in time.
      if (el.scrollHeight > el.clientHeight + 1) return;
      e.preventDefault();
      panBy(dy / v.px);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [panBy, zoomTo]);

  /** Rows to draw: an expanded bus contributes one row per bit, MSB first. */
  const drawRows = useMemo(() => {
    const out: Row[] = [];
    for (const row of rows) {
      out.push(row);
      if (expanded.has(row.signal.key)) {
        const samples = sim.waves.samples(row.signal.net);
        const latest = samples[samples.length - 1]?.val ?? ZERO;
        const bits = Math.min(32, row.signal.bits ?? valueBits(latest));
        for (const bit of bitLaneIndices(bits)) {
          out.push({ signal: row.signal, bit, parent: row.signal.key });
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates the mutable recorder
  }, [rows, expanded, sim.waves, version]);

  const laneH = Math.max(
    LANE_H,
    Math.min(LANE_H_MAX, Math.floor((size.h - RULER_H - HINT_H) / Math.max(1, drawRows.length))),
  );
  /**
   * The canvas is the whole signal list, not just what fits: rows outgrow the
   * panel and the wrapper scrolls vertically to reach them.
   */
  const contentH = Math.max(size.h, RULER_H + drawRows.length * laneH + HINT_H);

  // ---- drawing ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const theme = resolveTheme(canvas);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(contentH * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, size.w, contentH);

    const x = (c: number) => GUTTER + (c - origin) * px;
    const viewEnd = origin + visible;
    const lanesBottom = RULER_H + drawRows.length * laneH;
    const liveX = span === null ? GUTTER : x(domainEnd);

    // Row backgrounds: a faint zebra, and the hovered row lifted.
    drawRows.forEach((_, i) => {
      const yTop = RULER_H + i * laneH;
      if (i === hoverRow) {
        ctx.fillStyle = mixAlpha(theme.accent, 0.07);
        ctx.fillRect(0, yTop, size.w, laneH);
      } else if (i % 2 === 1) {
        ctx.fillStyle = mixAlpha(theme.text, 0.025);
        ctx.fillRect(0, yTop, size.w, laneH);
      }
    });

    // ---- everything time-based is clipped to the lane area ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, RULER_H, size.w - GUTTER, contentH - RULER_H);
    ctx.clip();

    // Past the live edge nothing was recorded: say so, rather than drawing a
    // stretch of time in which nothing happened.
    if (span !== null && liveX < size.w) {
      ctx.fillStyle = mixAlpha(theme.panel, 0.65);
      ctx.fillRect(Math.max(GUTTER, liveX), RULER_H, size.w, lanesBottom - RULER_H);
    }

    // Grid: whole cycles (labelled in the ruler) and, zoomed in, the half-cycle
    // ticks where the clock's falling edges land.
    const gridStep = niceStep(px);
    const firstGrid = Math.ceil(Math.max(domainStart, origin) / gridStep) * gridStep;
    ctx.lineWidth = 1;
    for (let c = firstGrid; c <= Math.min(viewEnd, domainEnd); c += gridStep) {
      const gx = Math.round(x(c)) + 0.5;
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(gx, RULER_H);
      ctx.lineTo(gx, lanesBottom);
      ctx.stroke();
    }
    if (px >= 36) {
      ctx.save();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = mixAlpha(theme.grid, 0.8);
      for (let c = Math.floor(origin) + 0.5; c <= Math.min(viewEnd, domainEnd); c += 1) {
        if (c < domainStart) continue;
        const gx = Math.round(x(c)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(gx, RULER_H);
        ctx.lineTo(gx, lanesBottom);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Traces.
    ctx.font = MONO;
    ctx.textBaseline = "middle";
    const segFrom = origin - 2 / px;
    const segTo = Math.min(domainEnd, viewEnd + 2 / px);
    drawRows.forEach((row, i) => {
      const yTop = RULER_H + i * laneH;
      const mid = yTop + laneH / 2;
      const placed = rowSamples(row, projectSamples(sim.waves.samples(row.signal.net), tb));
      if (placed.length === 0) {
        ctx.fillStyle = theme.textDim;
        ctx.font = SANS;
        ctx.fillText("no data yet — step or run the sim", GUTTER + 10, mid);
        ctx.font = MONO;
        return;
      }
      const latest = placed[placed.length - 1].val;
      const rowBits =
        row.bit !== undefined ? 1 : (row.signal.bits ?? Math.max(1, valueBits(latest)));
      const busRow = row.bit === undefined && isBus(row.signal, latest);
      const top = yTop + 6;
      const bottom = yTop + laneH - 6;
      const busHue = theme.bus[Math.abs(row.signal.net) % theme.bus.length] ?? theme.wire.high;

      let prevY: number | null = null;
      // Start no earlier than the first sample: a window that opens before it
      // has no value in effect yet, and `stepSegments` would draw nothing.
      for (const seg of stepSegments(placed, Math.max(segFrom, placed[0].x), segTo)) {
        const x0 = x(seg.from);
        let x1 = x(seg.to);
        // A state change is at least a pixel wide, so a sub-pixel toggle at a
        // far zoom still reads as "something happened here".
        if (x1 - x0 < 1) x1 = x0 + 1;
        const state = wireValueState(seg.val);
        if (busRow) {
          const color = state === "x" ? theme.wire.x : state === "z" ? theme.wire.z : busHue;
          if (state === "z") {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(x0, mid);
            ctx.lineTo(x1, mid);
            ctx.stroke();
          } else {
            // The classic bus shape: a band with slanted crossings where the
            // value changes, carrying the value as text.
            const s = Math.min(4, (x1 - x0) / 2);
            ctx.beginPath();
            ctx.moveTo(x0, mid);
            ctx.lineTo(x0 + s, top);
            ctx.lineTo(x1 - s, top);
            ctx.lineTo(x1, mid);
            ctx.lineTo(x1 - s, bottom);
            ctx.lineTo(x0 + s, bottom);
            ctx.closePath();
            ctx.fillStyle = mixAlpha(color, state === "x" ? 0.22 : 0.14);
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.3;
            ctx.stroke();
          }
          const text = waveText(seg.val, rowBits);
          const room = Math.min(x1, size.w) - Math.max(x0, GUTTER) - 10;
          const fitted = fitText(ctx, text, room);
          if (fitted !== null) {
            ctx.fillStyle = state === "x" ? theme.wire.x : theme.text;
            const tx = (Math.max(x0, GUTTER) + Math.min(x1, size.w)) / 2;
            ctx.fillText(fitted, tx - ctx.measureText(fitted).width / 2, mid + 0.5);
          }
        } else {
          const y =
            state === "high" ? top : state === "low" || state === "disconnected" ? bottom : mid;
          const color = theme.wire[state];
          if (state === "high") {
            ctx.fillStyle = mixAlpha(color, 0.12);
            ctx.fillRect(x0, top, x1 - x0, bottom - top);
          } else if (state === "x") {
            ctx.fillStyle = mixAlpha(color, 0.16);
            ctx.fillRect(x0, top, x1 - x0, bottom - top);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = state === "high" || state === "low" ? 1.8 : 1.3;
          ctx.beginPath();
          if (prevY !== null && prevY !== y) {
            ctx.moveTo(Math.round(x0) + 0.5, prevY);
            ctx.lineTo(Math.round(x0) + 0.5, y);
          } else {
            ctx.moveTo(x0, y);
          }
          ctx.lineTo(x1, y);
          ctx.stroke();
          prevY = y;
        }
        if (seg.contended === true) {
          ctx.strokeStyle = theme.violation;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0, bottom + 3);
          ctx.lineTo(x1, bottom + 3);
          ctx.stroke();
        }
      }
    });

    // The live edge: where the newest value is still in effect.
    if (span !== null && liveX >= GUTTER && liveX <= size.w) {
      ctx.strokeStyle = mixAlpha(theme.accent, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(liveX) + 0.5, RULER_H);
      ctx.lineTo(Math.round(liveX) + 0.5, lanesBottom);
      ctx.stroke();
    }

    // Where the run stopped (§90): a dashed rule at the halting cycle.
    if (halted !== null && halted.cycle <= domainEnd) {
      const hx = Math.round(x(halted.cycle)) + 0.5;
      ctx.save();
      ctx.strokeStyle = theme.wire.x;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, RULER_H);
      ctx.lineTo(hx, lanesBottom);
      ctx.stroke();
      ctx.restore();
    }

    // The pointer's cycle.
    if (cursor !== null) {
      const cx = Math.round(x(cursor)) + 0.5;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, RULER_H);
      ctx.lineTo(cx, Math.max(lanesBottom, RULER_H + laneH));
      ctx.stroke();
    }
    ctx.restore();

    // ---- name column ----
    ctx.fillStyle = theme.panel;
    ctx.globalAlpha = 0.96;
    ctx.fillRect(0, RULER_H, GUTTER, contentH - RULER_H);
    ctx.globalAlpha = 1;
    // Value shown per row: under the pointer, else at the view's right edge
    // (the live value while following).
    const readX = cursor ?? Math.min(viewEnd, domainEnd) - 1e-6;
    drawRows.forEach((row, i) => {
      const yTop = RULER_H + i * laneH;
      const mid = yTop + laneH / 2;
      if (i === hoverRow) {
        ctx.fillStyle = mixAlpha(theme.accent, 0.1);
        ctx.fillRect(0, yTop, GUTTER, laneH);
      }
      const placed = rowSamples(row, projectSamples(sim.waves.samples(row.signal.net), tb));
      const latest = placed[placed.length - 1]?.val;
      const rowBits =
        row.bit !== undefined ? 1 : (row.signal.bits ?? Math.max(1, valueBits(latest ?? ZERO)));
      const bus = row.bit === undefined && isBus(row.signal, latest);

      // × (remove) on hover, ▸/▾ for a bus, then the name.
      ctx.font = SANS;
      ctx.textBaseline = "middle";
      if (i === hoverRow && row.bit === undefined) {
        ctx.fillStyle = theme.textDim;
        ctx.fillText("×", 7, mid);
      }
      if (bus) {
        // Expand chevron: a small triangle, pointing down when open.
        ctx.fillStyle = theme.textDim;
        ctx.beginPath();
        if (expanded.has(row.signal.key)) {
          ctx.moveTo(19, mid - 2.5);
          ctx.lineTo(27, mid - 2.5);
          ctx.lineTo(23, mid + 2.5);
        } else {
          ctx.moveTo(21, mid - 4);
          ctx.lineTo(26, mid);
          ctx.lineTo(21, mid + 4);
        }
        ctx.closePath();
        ctx.fill();
      }
      const nameX = row.bit !== undefined ? 46 : 34;
      const watch = row.bit === undefined ? watches.get(row.signal.net) : undefined;
      const watchText = watch?.join(" · ");

      const sample = placed.length === 0 ? null : valueAt(placed, readX);
      const valueText = sample === null ? "" : waveText(sample.val, rowBits);
      ctx.font = MONO;
      const valueW = valueText === "" ? 0 : ctx.measureText(valueText).width + 6;
      const nameRoom =
        GUTTER -
        nameX -
        valueW -
        14 -
        (watchText !== undefined ? Math.min(90, 14 + watchText.length * 7) : 0);

      ctx.font = row.bit !== undefined ? MONO : SANS;
      ctx.fillStyle = row.bit !== undefined ? theme.textDim : theme.text;
      const label = row.bit !== undefined ? `bit ${row.bit}` : row.signal.label;
      const shown = fitText(ctx, label, nameRoom) ?? "";
      ctx.fillText(shown, nameX, mid);
      if (watchText !== undefined) {
        // A ring in the halt colour — "this signal can stop the run" (§90).
        const wx = nameX + ctx.measureText(shown).width + 9;
        ctx.strokeStyle = theme.wire.x;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(wx, mid, 3.2, 0, Math.PI * 2);
        ctx.stroke();
        // …and what it stops on, in whatever room the value leaves.
        ctx.font = MONO;
        const cond = fitText(ctx, watchText!, GUTTER - 10 - valueW - (wx + 8));
        if (cond !== null) {
          ctx.fillStyle = theme.wire.x;
          ctx.fillText(cond, wx + 8, mid);
        }
      }
      if (valueText !== "") {
        ctx.font = MONO;
        const state = wireValueState(sample!.val);
        ctx.fillStyle =
          state === "x"
            ? theme.wire.x
            : state === "z"
              ? theme.wire.z
              : cursor !== null
                ? theme.accent
                : theme.text;
        ctx.fillText(valueText, GUTTER - 10 - ctx.measureText(valueText).width, mid);
      }
      // Row separator.
      ctx.strokeStyle = mixAlpha(theme.panelBorder, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yTop + laneH - 0.5);
      ctx.lineTo(size.w, yTop + laneH - 0.5);
      ctx.stroke();
    });
    ctx.strokeStyle = theme.panelBorder;
    ctx.beginPath();
    ctx.moveTo(GUTTER - 0.5, RULER_H);
    ctx.lineTo(GUTTER - 0.5, contentH);
    ctx.stroke();

    // The hint under the rows: how to add signals and how to move.
    if (contentH - lanesBottom >= HINT_H - 4 && drawRows.length > 0) {
      ctx.font = SANS;
      ctx.fillStyle = theme.textDim;
      ctx.fillText(
        "Drag or scroll sideways to move through time · Ctrl/⌘+scroll zooms · ← → Home End",
        GUTTER + 12,
        lanesBottom + 18,
      );
    }

    // ---- ruler, pinned on top ----
    ctx.fillStyle = theme.panel;
    ctx.fillRect(0, 0, size.w, RULER_H);
    ctx.strokeStyle = theme.panelBorder;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(size.w, RULER_H - 0.5);
    ctx.moveTo(GUTTER - 0.5, 0);
    ctx.lineTo(GUTTER - 0.5, RULER_H);
    ctx.stroke();
    ctx.font = SANS;
    ctx.fillStyle = theme.textDim;
    ctx.fillText("cycle", 12, RULER_H / 2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, size.w - GUTTER, RULER_H);
    ctx.clip();
    ctx.font = MONO;
    for (let c = firstGrid; c <= Math.min(viewEnd, domainEnd); c += gridStep) {
      const gx = Math.round(x(c)) + 0.5;
      ctx.strokeStyle = theme.panelBorder;
      ctx.beginPath();
      ctx.moveTo(gx, RULER_H - 6);
      ctx.lineTo(gx, RULER_H);
      ctx.stroke();
      ctx.fillStyle = theme.textDim;
      ctx.fillText(String(c), gx + 4, RULER_H / 2);
    }
    if (cursor !== null) {
      const label = `${Math.floor(cursor)}${cursor % 1 >= 0.5 ? "½" : ""}`;
      const w = ctx.measureText(label).width + 12;
      const cx = x(cursor);
      const bx = Math.min(size.w - w - 2, Math.max(GUTTER + 2, cx - w / 2));
      ctx.fillStyle = theme.accent;
      roundRect(ctx, bx, 3, w, RULER_H - 6, 4);
      ctx.fill();
      ctx.fillStyle = theme.bg;
      ctx.fillText(label, bx + 6, RULER_H / 2);
    }
    ctx.restore();
  }, [
    drawRows,
    size,
    contentH,
    px,
    origin,
    visible,
    cursor,
    hoverRow,
    expanded,
    sim.waves,
    tb,
    version,
    span,
    domainStart,
    domainEnd,
    laneH,
    watches,
    halted,
  ]);

  // ---- pointer: drag to pan, click the name column to remove / expand ----
  const drag = useRef<{ x: number; origin: number } | null>(null);
  const rowAt = (y: number): number | null => {
    const i = Math.floor((y - RULER_H) / laneH);
    return y >= RULER_H && i >= 0 && i < drawRows.length ? i : null;
  };

  const toggleExpand = (key: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    if (cx < GUTTER) {
      const i = rowAt(cy);
      const row = i === null ? undefined : drawRows[i];
      if (row === undefined || row.bit !== undefined) return;
      if (cx < 16) {
        removedRef.current.add(row.signal.key);
        setRows((cur) => cur.filter((r) => r.signal.key !== row.signal.key));
        setExpanded((cur) => {
          const next = new Set(cur);
          next.delete(row.signal.key);
          return next;
        });
        setHoverRow(null);
      } else if (cx < 30) {
        const samples = sim.waves.samples(row.signal.net);
        if (isBus(row.signal, samples[samples.length - 1]?.val)) toggleExpand(row.signal.key);
      }
      return;
    }
    drag.current = { x: e.clientX, origin };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const d = drag.current;
    if (d !== null) {
      panTo(d.origin - (e.clientX - d.x) / px);
    }
    setHoverRow(rowAt(cy));
    setCursor(cx >= GUTTER ? Math.min(domainEnd, origin + (cx - GUTTER) / px) : null);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // ---- the scrollbar: the whole recorded run, with the window as its thumb ----
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scrub = useRef<{ x: number; origin: number } | null>(null);
  const thumbWidth = Math.min(1, visible / domain);
  const thumbLeft = Math.min(1 - thumbWidth, Math.max(0, (origin - domainStart) / domain));

  const onThumbDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    scrub.current = { x: e.clientX, origin };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onThumbMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = scrub.current;
    const track = trackRef.current;
    if (d === null || track === null) return;
    const width = track.getBoundingClientRect().width;
    if (width <= 0) return;
    panTo(d.origin + ((e.clientX - d.x) / width) * domain);
  };
  const onThumbUp = (e: React.PointerEvent<HTMLDivElement>) => {
    scrub.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };
  /** A click on the track centres the window there. */
  const onTrackDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    panTo(domainStart + frac * domain - visible / 2);
  };

  const addPicked = useCallback(() => {
    setRows((cur) => {
      const have = new Set(cur.map((r) => r.signal.key));
      const next = [...cur];
      for (const s of picked) if (!have.has(s.key)) next.push({ signal: s });
      return next;
    });
    onNotify?.(`Added ${picked.length} selected signal${picked.length === 1 ? "" : "s"}`);
  }, [picked, onNotify]);

  // A readout is a cycle number: nobody wants 1.6041666 in the bar.
  const current =
    cursor === null ? Math.floor(span?.lastEvent ?? 0) : Math.max(0, Math.floor(cursor));
  const spanText =
    span === null
      ? "no samples yet — run the sim"
      : `cycles ${Math.floor(span.first)}–${Math.floor(span.lastEvent)}`;

  return (
    <div className="wave-view">
      <div className="wave-bar">
        <strong>Waveform</strong>
        <span className="wave-bar-text">
          {circuitLabel} · {spanText} · {drawRows.length} row
          {drawRows.length === 1 ? "" : "s"}
        </span>
        <span className="wave-bar-spacer" />
        {halted !== null && (
          <span className="wave-bar-text wave-bar-halted" title={halted.details}>
            {halted.reason === "breakpoint" ? "⏸ breakpoint" : `⛔ ${halted.reason}`} at cycle{" "}
            {halted.cycle}
          </span>
        )}
        <span className="wave-bar-text">cycle {current}</span>
        <span className="wave-bar-sep" aria-hidden="true" />
        <button
          className="secondary wave-icon-btn"
          aria-label="Zoom out"
          title="Zoom out (−, or Ctrl/⌘+scroll)"
          onClick={() => zoomTo(px / ZOOM_STEP)}
        >
          <MinusIcon />
        </button>
        <button
          className="secondary wave-icon-btn"
          aria-label="Zoom in"
          title="Zoom in (+, or Ctrl/⌘+scroll)"
          onClick={() => zoomTo(px * ZOOM_STEP)}
        >
          <PlusIcon />
        </button>
        <button className="secondary" onClick={fit} title="Fit the whole run (F)">
          Fit
        </button>
        <button
          className={follow ? "" : "secondary"}
          aria-pressed={follow}
          onClick={() => setFollow((f) => !f)}
          title="Keep the newest cycle in view while the sim runs (End)"
        >
          Follow
        </button>
        <span className="wave-bar-sep" aria-hidden="true" />
        <button className="secondary" onClick={addPicked} disabled={picked.length === 0}>
          Add selection{picked.length > 0 ? ` (${picked.length})` : ""}
        </button>
        <button
          className="secondary"
          onClick={() => {
            for (const r of rows) removedRef.current.add(r.signal.key);
            setRows([]);
          }}
          disabled={rows.length === 0}
        >
          Remove all
        </button>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="wave-canvas-wrap" ref={wrapRef}>
        {rows.length === 0 ? (
          <div className="wave-empty">
            <p className="wave-empty-title">No signals yet</p>
            <p>
              Right-click a wire or part on the canvas and choose <strong>Show in waveform</strong>,
              or select it and press <strong>Add selection</strong>.
            </p>
            <p>Named probes, registers and memories appear here on their own.</p>
          </div>
        ) : null}
        <canvas
          ref={canvasRef}
          className={`wave-canvas${dragging ? " dragging" : ""}`}
          style={{ width: size.w, height: contentH }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            if (drag.current === null) {
              setCursor(null);
              setHoverRow(null);
            }
          }}
          onDoubleClick={(e) => {
            // Double-click a bus's name to expand/collapse its bits.
            const rect = e.currentTarget.getBoundingClientRect();
            if (e.clientX - rect.left >= GUTTER) return;
            const i = rowAt(e.clientY - rect.top);
            const row = i === null ? undefined : drawRows[i];
            if (row === undefined || row.bit !== undefined) return;
            const samples = sim.waves.samples(row.signal.net);
            if (isBus(row.signal, samples[samples.length - 1]?.val)) toggleExpand(row.signal.key);
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

function clampPx(p: number): number {
  return Math.min(MAX_PX, Math.max(MIN_PX, p));
}

/** A cycle step for the grid that keeps labels ~80px apart. */
function niceStep(px: number): number {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  return steps.find((s) => s * px >= 80) ?? steps[steps.length - 1];
}

/** A row's samples: the signal itself, or one bit of it for a bit lane. */
function rowSamples(row: Row, placed: PlacedSample[]): PlacedSample[] {
  if (row.bit === undefined) return placed;
  const bit = row.bit;
  return placed.map((s) => ({ ...s, val: extractBit(s.val, bit) }));
}

/** `text` if it fits `room` px, else a clipped `abc…`, else null. */
function fitText(ctx: CanvasRenderingContext2D, text: string, room: number): string | null {
  if (room <= 0) return null;
  if (ctx.measureText(text).width <= room) return text;
  for (let n = text.length - 1; n >= 2; n--) {
    const t = `${text.slice(0, n)}…`;
    if (ctx.measureText(t).width <= room) return t;
  }
  return null;
}

/** A CSS colour at `alpha` (hex, rgb() and named colours via color-mix). */
function mixAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex !== null) {
    let h = hex[1];
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = Number.parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
