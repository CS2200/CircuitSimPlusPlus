import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { resolveTheme, type Theme } from "../render/theme";
import type { SimController } from "../sim/controller";
import {
  bitLaneIndices,
  defaultSignals,
  extractBit,
  stepSegments,
  valueAt,
  valueBits,
  waveText,
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

const LANE_H = 22;
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
  picked,
  circuitLabel,
  onClose,
  onNotify,
}: {
  sim: SimController;
  /** Signals the canvas selection resolves to right now (App resolves them). */
  picked: WaveSignal[];
  circuitLabel: string;
  onClose: () => void;
  onNotify?: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<Row[]>(() =>
    defaultSignals(sim.store.named).map((signal) => ({ signal })),
  );
  const [pxPerCycle, setPxPerCycle] = useState(6);
  const [origin, setOrigin] = useState(0);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<{ cycle: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const themeRef = useRef<Theme | null>(null);

  // Redraw on every applied frame (the store bumps ≤ once per frame while
  // running) — reading the recorder directly, like the canvas reads netValues.
  const version = useSyncExternalStore(sim.store.subscribe, () => sim.store.getVersion());
  const span = sim.waves.span;

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
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /** Rows to draw: an expanded bus contributes one row per bit, MSB first. */
  const drawRows = useMemo(() => {
    const out: Row[] = [];
    for (const row of rows) {
      out.push(row);
      if (expanded.has(row.signal.key)) {
        const sample = valueAt(sim.waves.samples(row.signal.net), sim.waves.span?.last ?? 0);
        const bits = Math.min(32, valueBits(sample?.val ?? { v: "0", x: "0", z: "0" }));
        for (const bit of bitLaneIndices(bits)) {
          out.push({ signal: row.signal, bit, parent: row.signal.key });
        }
      }
    }
    return out;
  }, [rows, expanded, sim.waves, version]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Fit the whole recorded run into the canvas. */
  const fit = useCallback(() => {
    if (span === null) return;
    const width = size.w - GUTTER;
    const cycles = Math.max(1, span.last - span.first + 1);
    setPxPerCycle(Math.max(0.5, Math.min(80, width / cycles)));
    setOrigin(Math.max(0, span.first));
  }, [span, size.w]);

  useEffect(() => {
    fit();
    // Fit once when the trace first has a span, then leave the user in charge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [span === null]);

  // Follow the live edge while the sim runs (a scope's right-anchored view).
  useEffect(() => {
    if (!follow || span === null) return;
    const width = size.w - GUTTER;
    setOrigin(span.last - width / pxPerCycle);
  }, [follow, span, pxPerCycle, size.w]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const theme = themeRef.current ?? (themeRef.current = resolveTheme(canvas));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, size.w, size.h);

    const laneW = size.w - GUTTER;
    const laneH = LANE_H;
    const x = (cycle: number) => GUTTER + (cycle - origin) * pxPerCycle;
    const visibleTo = origin + laneW / pxPerCycle;
    const first = Math.max(0, Math.floor(origin));
    const last = Math.ceil(visibleTo);

    // Cycle gridlines: a step that keeps labels readable at any zoom.
    const target = 90;
    const stepCandidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    const gridStep =
      stepCandidates.find((s) => s * pxPerCycle >= target) ??
      stepCandidates[stepCandidates.length - 1];
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let c = Math.ceil(first / gridStep) * gridStep; c <= last; c += gridStep) {
      const gx = x(c);
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(gx) + 0.5, 0);
      ctx.lineTo(Math.round(gx) + 0.5, size.h - AXIS_H);
      ctx.stroke();
      ctx.fillStyle = theme.textDim;
      ctx.textAlign = "center";
      ctx.fillText(String(c), gx, size.h - AXIS_H / 2);
    }

    // Lanes.
    ctx.textAlign = "left";
    drawRows.forEach((row, i) => {
      const yTop = PAD_TOP + i * laneH;
      if (yTop > size.h - AXIS_H) return;
      const mid = yTop + laneH / 2;
      const high = yTop + 5;
      const low = yTop + laneH - 5;
      const samples = sim.waves.samples(row.signal.net);

      // Gutter: label + the value under the cursor.
      const atCursor = cursor === null ? null : rowValueAt(row, samples, cursor.cycle);
      ctx.fillStyle = row.bit !== undefined ? theme.textDim : theme.text;
      const indent = row.bit !== undefined ? 12 : 0;
      const label = row.bit !== undefined ? `[${row.bit}]` : row.signal.label;
      ctx.fillText(clip(label, 17), 6 + indent, mid);
      if (atCursor !== null) {
        ctx.fillStyle = theme.textDim;
        const text = waveText(
          atCursor.val,
          row.bit !== undefined ? 1 : Math.max(1, bitsOf(atCursor.val)),
        );
        ctx.fillText(text, GUTTER - 12 - ctx.measureText(text).width, mid);
      }

      // The trace: hold the level, then drop/raise at each change.
      const segs = stepSegments(samples, first, last);
      let plotted = false;
      for (const seg of segs) {
        const x0 = Math.max(GUTTER, x(seg.from));
        const x1 = Math.min(size.w, x(seg.to));
        if (x1 <= x0) continue;
        const state = wireValueState(seg.val);
        const y = state === "high" ? high : state === "low" || state === "disconnected" ? low : mid;
        ctx.strokeStyle = row.bit !== undefined ? theme.text : theme.wire[state];
        ctx.lineWidth = state === "high" || state === "low" ? 1.6 : 1.2;
        ctx.beginPath();
        if (plotted) {
          // Vertical transition from the previous level to this one.
          ctx.moveTo(x0 + 0.5, y);
        } else {
          ctx.moveTo(x0, y);
        }
        ctx.lineTo(x1, y);
        ctx.stroke();
        if (seg.contended === true) {
          ctx.strokeStyle = theme.violation;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0, y - 3);
          ctx.lineTo(x1, y - 3);
          ctx.stroke();
        }
        // Bus value as text, when the segment is wide enough to read it.
        if (row.bit === undefined && seg.val !== undefined) {
          const text = waveText(seg.val, Math.max(1, bitsOf(seg.val)));
          if (x1 - x0 > ctx.measureText(text).width + 8 && text !== "0" && text !== "1") {
            ctx.fillStyle = theme.textDim;
            ctx.fillText(text, x0 + 4, mid - 6);
          }
        }
        plotted = true;
      }
      if (samples.length === 0) {
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

    // Cursor, over everything.
    if (cursor !== null) {
      const cx = Math.round(x(cursor.cycle)) + 0.5;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, size.h - AXIS_H);
      ctx.stroke();
    }

    // Gutter separator.
    ctx.strokeStyle = theme.panelBorder;
    ctx.beginPath();
    ctx.moveTo(GUTTER - 0.5, 0);
    ctx.lineTo(GUTTER - 0.5, size.h);
    ctx.stroke();

    function bitsOf(val: WireValue): number {
      return Math.max(4, valueBits(val));
    }
    function rowValueAt(
      row: Row,
      samples: readonly { cycle: number; val: WireValue }[],
      cycle: number,
    ) {
      const s = valueAt(samples, cycle);
      if (s === null) return null;
      return row.bit === undefined ? s : { val: extractBit(s.val, row.bit) };
    }
  }, [drawRows, size, pxPerCycle, origin, cursor, sim.waves, version, span]);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      if (cx < GUTTER) return;
      const cycleAt = origin + (cx - GUTTER) / pxPerCycle;
      const next = Math.max(0.25, Math.min(200, pxPerCycle * Math.pow(1.0015, -e.deltaY)));
      setPxPerCycle(next);
      setOrigin(cycleAt - (cx - GUTTER) / next);
      setFollow(false);
    },
    [origin, pxPerCycle],
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

  const current = cursor === null ? (span?.last ?? 0) : Math.round(cursor.cycle);
  const spanText =
    span === null ? "no samples yet — run the sim" : `cycles ${span.first}–${span.last}`;

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
        <button className="secondary" onClick={() => setPxPerCycle((p) => Math.max(0.25, p / 1.5))}>
          −
        </button>
        <button className="secondary" onClick={() => setPxPerCycle((p) => Math.min(200, p * 1.5))}>
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
          style={{ width: size.w, height: size.h }}
          onWheel={onWheel}
          onMouseMove={onMove}
          onMouseLeave={() => setCursor(null)}
          onDoubleClick={(e) => {
            // Double-click a label to expand/collapse a bus, or drop the row.
            const rect = e.currentTarget.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const i = Math.floor((y - PAD_TOP) / LANE_H);
            const row = drawRows[i];
            if (row === undefined || row.bit !== undefined) return;
            const bits = valueBits(
              valueAt(sim.waves.samples(row.signal.net), span?.last ?? 0)?.val ?? {
                v: "0",
                x: "0",
                z: "0",
              },
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
    </div>
  );
}

/** One-line clip for the gutter (the canvas has no ellipsis). */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
