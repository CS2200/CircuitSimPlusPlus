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
import { DocScene, type SimOverlay } from "../editor/docScene";
import { ToolMachine } from "../editor/tools";
import { compSize } from "../editor/catalog";
import type { SimController } from "../sim/controller";

/**
 * EditorCanvas (FRONTEND.md U3): the circuit editor — CanvasHost plumbing
 * + DocScene rendering + ToolMachine interaction. Owns the selection model
 * and the keyboard map; reports status for the chrome (statusbar/palette)
 * via `onStatus`.
 */

export interface EditorStatus {
  cursor: Vec2 | null;
  selection: number;
  dirty: boolean;
  placing: string | null;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface EditorHandle {
  startPlacing(type: string): void;
  placeAt(type: string, world: Vec2): void;
  cancel(): void;
  undo(): void;
  redo(): void;
  rotate(): void;
  deleteSelection(): void;
  copy(): void;
  paste(): void;
}

export default forwardRef<
  EditorHandle,
  {
    doc: CircuitDocument;
    themeName: string;
    onStatus?: (s: EditorStatus) => void;
    onEditComponent?: (compId: string) => void;
    /** Sim session (U5): wire state overlay + halt marker. */
    sim?: SimController;
  }
>(function EditorCanvas({ doc, themeName, onStatus, onEditComponent, sim }, ref) {
  const [tick, setTick] = useState(0);
  const { scene, sel, tool } = useMemo(() => {
    const scene = new DocScene();
    const sel = new SelectionModel();
    const tool = new ToolMachine(
      doc,
      scene,
      sel,
      () => 0,
      () => setTick((t) => t + 1),
    );
    return { scene, sel, tool };
  }, [doc]);

  useEffect(() => {
    tool.onEditComponent = onEditComponent;
    return () => {
      tool.onEditComponent = undefined;
    };
  }, [tool, onEditComponent]);

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

  const draw = useCallback<CanvasHostProps["draw"]>(
    (renderer, camera, view, theme) => {
      scene.sync(doc, 0);
      let simOverlay: SimOverlay | undefined;
      if (sim !== undefined && sim.store.loaded) {
        const store = sim.store;
        const highlight = sim.haltHighlight();
        simOverlay = {
          valueForWire: (i) => {
            const net = store.wireToNet?.get(i);
            return net === undefined ? undefined : store.netValues.get(net);
          },
          haltCompId:
            highlight === null ? null : (doc.circuit(0).components[highlight]?.id ?? null),
        };
      }
      scene.draw(renderer, theme, camera, view, sel, tool.overlay(), simOverlay);
    },
    [doc, scene, sel, tool, sim, simVersion],
  );

  const report = useCallback(() => {
    onStatus?.({
      cursor: cursorRef.current,
      selection: sel.size,
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
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;
      let handled = true;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") doc.undo();
      else if (
        (mod && e.key.toLowerCase() === "y") ||
        (mod && e.shiftKey && e.key.toLowerCase() === "z")
      )
        doc.redo();
      else if (mod && e.key.toLowerCase() === "c") tool.copy();
      else if (mod && e.key.toLowerCase() === "v") tool.paste();
      else if (mod && e.key.toLowerCase() === "a") tool.selectAll();
      else if (e.key === "Escape") tool.cancel();
      else if (e.key === "Delete" || e.key === "Backspace") tool.deleteSelection();
      else if (e.key.toLowerCase() === "r" && !mod) tool.rotateSelection();
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
      startPlacing: (type) => {
        tool.startPlacing(type);
        bump();
      },
      placeAt: (type, world) => {
        doc.addComponent(0, { type, pos: [Math.round(world.x), Math.round(world.y)], rot: "E" });
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
      paste: () => {
        tool.paste();
        bump();
      },
    }),
    [doc, tool, bump],
  );

  return (
    <CanvasHost
      draw={draw}
      revision={tick + simVersion}
      themeName={themeName}
      sceneBounds={initialBounds}
      onPointerDown={(w, info) => tool.down(w, info)}
      onPointerMove={(w) => tool.move(w)}
      onPointerUp={(w, info) => tool.up(w, info)}
      onDoubleClick={(w) => tool.doubleClick(w)}
      onHover={(w) => {
        cursorRef.current = w;
        tool.hover(w);
        report();
      }}
      onDropWorld={(w, e) => {
        const type = e.dataTransfer.getData("text/x-csx-type");
        if (type !== "") {
          // drop lands with the body CENTERED on the cursor
          const { w: bw, h: bh } = compSize({ type });
          doc.addComponent(0, {
            type,
            pos: [Math.round(w.x - bw / 2), Math.round(w.y - bh / 2)],
            rot: "E",
          });
          bump();
        }
      }}
    />
  );
});
