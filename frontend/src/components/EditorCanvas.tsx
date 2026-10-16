import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import CanvasHost, { type CanvasHostProps } from "./CanvasHost";
import type { CircuitDocument } from "../model/document";
import { SelectionModel } from "../model/selection";
import type { Vec2 } from "../render/geom";
import { DocScene, type SimOverlay, type ViolationMarker } from "../editor/docScene";
import { ToolMachine } from "../editor/tools";
import { compSize } from "../editor/catalog";
import type { SimController } from "../sim/controller";
import { PulseTracker } from "../sim/pulses";

/** Pulses animate up to this effective speed (U7). */
const PULSE_MAX_EFF_HZ = 120;

/**
 * EditorCanvas (FRONTEND.md U3): the circuit editor — CanvasHost plumbing
 * + DocScene rendering + ToolMachine interaction. Owns the selection model
 * and the keyboard map; reports status for the chrome (statusbar/palette)
 * via `onStatus`.
 */

export interface EditorStatus {
  cursor: Vec2 | null;
  selection: number;
  /** Selected component ids at report time (one → the Inspector shows it). */
  selectedComponents: readonly string[];
  /** Selected wire indices at report time (one → the Inspector styles it). */
  selectedWires: readonly number[];
  /** Document revision at report time (invalidates external edits/undo). */
  revision: number;
  dirty: boolean;
  placing: string | null;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface EditorHandle {
  startPlacing(
    type: string,
    sticky?: boolean,
    attrs?: Record<string, unknown>,
    rot?: "N" | "E" | "S" | "W",
  ): void;
  /** Redraw after an out-of-band doc mutation (properties dialog, …). */
  refresh(): void;
  placeAt(type: string, world: Vec2, attrs?: Record<string, unknown>): void;
  cancel(): void;
  undo(): void;
  redo(): void;
  rotate(): void;
  deleteSelection(): void;
  copy(): void;
  cut(): void;
  paste(): void;
  selectAll(): void;
}

export default forwardRef<
  EditorHandle,
  {
    doc: CircuitDocument;
    themeName: string;
    /** Index of the sheet being edited (subcircuits are separate sheets). */
    sheetIdx?: number;
    onStatus?: (s: EditorStatus) => void;
    onEditComponent?: (compId: string, focusField?: string) => void;
    /** Right-click a subcircuit instance: jump to its definition tab. */
    onOpenSubcircuit?: (circuit: string) => void;
    /** Sim session (U5): wire state overlay + halt marker. */
    sim?: SimController;
    /** Observed critical path to highlight (U7), as document comp ids. */
    pathIds?: readonly string[] | null;
    /** Setup/hold violation markers for the current sheet (U7). */
    violations?: readonly ViolationMarker[] | null;
    /** Signal-pulse animation (Settings → Canvas); default on. */
    pulsesOn?: boolean;
    /** Coarse canvas grid (Settings → Canvas, UI_OVERHAUL §15); default off. */
    gridOn?: boolean;
    /** Live value readouts on parts (Settings → Canvas, §25); default on. */
    showValues?: boolean;
    /** Frame-rate overlay in the canvas corner (Settings → Canvas); default off. */
    showPerf?: boolean;
  }
>(function EditorCanvas(
  {
    doc,
    themeName,
    sheetIdx = 0,
    onStatus,
    onEditComponent,
    onOpenSubcircuit,
    sim,
    pathIds,
    violations,
    pulsesOn = true,
    gridOn = false,
    showValues = true,
    showPerf = false,
  },
  ref,
) {
  const [tick, setTick] = useState(0);
  // One tracker per document (fresh pulse state per circuit).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- doc identity is the reset signal
  const pulses = useMemo(() => new PulseTracker(), [doc]);
  const [pulsesLive, setPulsesLive] = useState(false);
  const lastPulseChanges = useRef<readonly unknown[] | null>(null);
  // Width-mismatch warnings pulse, so the canvas keeps animating while any
  // net disagrees (gated by the same animation pref as signal pulses, §19).
  const [mismatchLive, setMismatchLive] = useState(false);
  const mismatchRef = useRef(false);
  // Tools/scene read the CURRENT sheet through a ref so a sheet switch does
  // not rebuild the whole tool machine (doc identity still does).
  const sheetRef = useRef(sheetIdx);
  sheetRef.current = sheetIdx;
  const { scene, sel, tool } = useMemo(() => {
    const scene = new DocScene();
    const sel = new SelectionModel();
    const tool = new ToolMachine(
      doc,
      scene,
      sel,
      () => sheetRef.current,
      () => setTick((t) => t + 1),
    );
    return { scene, sel, tool };
  }, [doc]);

  useEffect(() => {
    tool.onEditComponent = onEditComponent;
    tool.onOpenSubcircuit = onOpenSubcircuit;
    return () => {
      tool.onEditComponent = undefined;
      tool.onOpenSubcircuit = undefined;
    };
  }, [tool, onEditComponent, onOpenSubcircuit]);

  // Shift+click a clock ticks the sim once (UI_OVERHAUL §47): load on demand
  // like the transport's Ctrl+J, then step.
  useEffect(() => {
    tool.onTick = () => {
      if (sim === undefined) return;
      void (async () => {
        if (!sim.store.loaded && !(await sim.load(doc))) return;
        await sim.stepTick();
      })();
    };
    return () => {
      tool.onTick = undefined;
    };
  }, [tool, sim, doc]);

  // Center the camera once per document (never re-center on edits).
  const initialBounds = useMemo(() => {
    scene.sync(doc, 0);
    return scene.bounds;
  }, [doc, scene]);

  const bump = useCallback(() => setTick((t) => t + 1), []);
  const cursorRef = useRef<Vec2 | null>(null);

  // Sim frames bump the canvas (the store mutates in place; version signals).
  const simVersion = useSyncExternalStore(
    sim?.store.subscribe ?? (() => () => {}),
    sim ? () => sim.store.getVersion() : () => 0,
  );

  // Sheet switch: repaint the new circuit and drop the old sheet's
  // selection (its ids are meaningless here) and pulse bookkeeping.
  useEffect(() => {
    sel.clear();
    lastPulseChanges.current = null;
    setTick((t) => t + 1);
  }, [sheetIdx, sel]);

  const draw = useCallback<CanvasHostProps["draw"]>(
    (renderer, camera, view, theme, tMs) => {
      scene.sync(doc, sheetRef.current);
      const hasMismatch = scene.hasMismatch();
      if (hasMismatch !== mismatchRef.current) {
        mismatchRef.current = hasMismatch;
        setMismatchLive(hasMismatch);
      }
      let simOverlay: SimOverlay | undefined;
      // net_map is root-sheet-only (contract v1.1): no sim overlay on
      // subcircuit sheets.
      if (sim !== undefined && sim.store.loaded && sheetRef.current === 0) {
        const store = sim.store;
        const highlight = sim.haltHighlight();
        // Pulse spawn: once per flushed frame at low speed (manual steps
        // always qualify — that's the teaching view); gated by the
        // Settings → Canvas toggle.
        const st = store.status;
        const pulseOk =
          pulsesOn && (!(st?.running ?? false) || (st?.eff_hz ?? 0) <= PULSE_MAX_EFF_HZ);
        if (pulseOk && store.lastChanged !== lastPulseChanges.current) {
          lastPulseChanges.current = store.lastChanged;
          if (store.lastChanged.length > 0) {
            pulses.spawn(store.lastChanged, tMs);
            setPulsesLive(true);
          }
        }
        const activePulses = pulses.active(tMs);
        if (activePulses === null && pulsesLive) setPulsesLive(false);
        simOverlay = {
          cycle: store.cycle,
          valueForWire: (i) => {
            const net = store.wireToNet?.get(i);
            return net === undefined ? undefined : store.netValues.get(net);
          },
          haltCompId:
            highlight === null ? null : (doc.circuit(0).components[highlight]?.id ?? null),
          path: pathIds ?? null,
          violations: violations ?? null,
          pulses: activePulses?.flatMap((p) =>
            (store.netToWires?.get(p.net) ?? []).map((wireIdx) => ({
              wireIdx,
              phase: p.phase,
            })),
          ),
        };
      }
      scene.draw(
        renderer,
        theme,
        camera,
        view,
        sel,
        { ...tool.overlay(), now: pulsesOn ? tMs : undefined },
        simOverlay,
        gridOn,
        showValues,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- simVersion invalidates the mutate-in-place sim store
    [
      doc,
      scene,
      sel,
      tool,
      sim,
      simVersion,
      pathIds,
      violations,
      pulses,
      pulsesLive,
      pulsesOn,
      gridOn,
      showValues,
    ],
  );

  const report = useCallback(() => {
    onStatus?.({
      cursor: cursorRef.current,
      selection: sel.size,
      selectedComponents: [...sel.components],
      selectedWires: [...sel.wires],
      revision: doc.revision,
      dirty: doc.dirty,
      placing: tool.placingType,
      busy: tool.isBusy,
      canUndo: doc.canUndo,
      canRedo: doc.canRedo,
      undoLabel: doc.peekUndoLabel(),
      redoLabel: doc.peekRedoLabel(),
    });
  }, [doc, sel, tool, onStatus]);

  // report status on every tool/doc change
  useEffect(() => {
    report();
  }, [tick, report]);

  // keyboard map
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore keys aimed at a text field or while a dialog is open. Buttons
      // are NOT excluded: after picking a palette item the button keeps focus,
      // and R/Delete/arrows must still drive the canvas (widgets that own an
      // arrow key stop it from propagating instead — §22).
      const target = e.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector(".help-overlay") !== null) return;
      const mod = e.ctrlKey || e.metaKey;
      let handled = true;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") doc.undo();
      else if (
        (mod && e.key.toLowerCase() === "y") ||
        (mod && e.shiftKey && e.key.toLowerCase() === "z")
      )
        doc.redo();
      else if (mod && e.key.toLowerCase() === "c") tool.copy();
      else if (mod && e.key.toLowerCase() === "x") tool.cut();
      else if (mod && e.key.toLowerCase() === "v") tool.paste();
      else if (mod && e.key.toLowerCase() === "a") tool.selectAll();
      else if (e.key === "Escape") tool.cancel();
      else if (e.key === "Delete" || e.key === "Backspace") tool.deleteSelection();
      else if (e.key.toLowerCase() === "r" && !mod) tool.rotateSelection();
      // Arrows point the selection / placement ghost AT that direction:
      // right → East, left → West, up → North, down → South (UI_OVERHAUL §22).
      else if (e.key === "ArrowRight" && !mod) tool.faceSelection("E");
      else if (e.key === "ArrowLeft" && !mod) tool.faceSelection("W");
      else if (e.key === "ArrowUp" && !mod) tool.faceSelection("N");
      else if (e.key === "ArrowDown" && !mod) tool.faceSelection("S");
      else if (e.key.toLowerCase() === "x" && !mod) tool.flipRoute();
      else handled = false;
      if (handled) {
        e.preventDefault();
        bump();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, tool, bump]);

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      startPlacing: (type, sticky = false, attrs, rot) => {
        tool.startPlacing(type, sticky, attrs, rot);
        bump();
      },
      refresh: () => {
        // Repaint AND re-report synchronously: out-of-band doc mutations
        // (inspector commits) must land in the SAME batch they were made in,
        // so the Inspector reflects them without a one-frame flicker.
        bump();
        report();
      },
      placeAt: (type, world, attrs) => {
        doc.addComponent(sheetRef.current, {
          type,
          pos: [Math.round(world.x), Math.round(world.y)],
          rot: "E",
          ...(attrs !== undefined && { attrs }),
        });
        bump();
      },
      cancel: () => {
        tool.cancel();
        bump();
      },
      undo: () => {
        doc.undo();
        bump();
      },
      redo: () => {
        doc.redo();
        bump();
      },
      rotate: () => {
        tool.rotateSelection();
        bump();
      },
      deleteSelection: () => {
        tool.deleteSelection();
        bump();
      },
      copy: () => {
        tool.copy();
        bump();
      },
      cut: () => {
        tool.cut();
        bump();
      },
      paste: () => {
        tool.paste();
        bump();
      },
      selectAll: () => {
        tool.selectAll();
        bump();
      },
    }),
    [doc, tool, bump, report],
  );

  return (
    <CanvasHost
      draw={draw}
      revision={tick + simVersion}
      animate={pulsesLive || (pulsesOn && mismatchLive)}
      showPerf={showPerf}
      themeName={themeName}
      sceneBounds={initialBounds}
      onPointerDown={(w, info) => tool.down(w, info)}
      onPointerMove={(w) => tool.move(w)}
      onPointerUp={(w, info) => tool.up(info, w)}
      onDoubleClick={(w) => tool.doubleClick(w)}
      onHover={(w) => {
        cursorRef.current = w;
        tool.hover(w);
        report();
      }}
      onShiftPress={(w) => tool.tickClockAt(w)}
      onDropWorld={(w, e) => {
        const type = e.dataTransfer.getData("text/x-csx-type");
        if (type !== "") {
          const rawAttrs = e.dataTransfer.getData("text/x-csx-attrs");
          let attrs: Record<string, unknown> | undefined;
          if (rawAttrs !== "") {
            try {
              attrs = JSON.parse(rawAttrs) as Record<string, unknown>;
            } catch {
              attrs = undefined; // malformed payload — place attr-less
            }
          }
          // drop lands with the body CENTERED on the cursor
          const rotRaw = e.dataTransfer.getData("text/x-csx-rot");
          const rot =
            rotRaw === "N" || rotRaw === "E" || rotRaw === "S" || rotRaw === "W" ? rotRaw : "E";
          const { w: bw, h: bh } = compSize({ type, attrs }, doc.circuits);
          doc.addComponent(sheetRef.current, {
            type,
            pos: [Math.round(w.x - bw / 2), Math.round(w.y - bh / 2)],
            rot,
            ...(attrs !== undefined && { attrs }),
          });
          bump();
        }
      }}
    />
  );
});
