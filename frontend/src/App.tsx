import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import StressCanvas from "./components/StressCanvas";
import EditorCanvas, { type EditorHandle, type EditorStatus } from "./components/EditorCanvas";
import PropertiesDialog from "./components/PropertiesDialog";
import SimBar from "./components/SimBar";
import WatchPanel from "./components/WatchPanel";
import { AboutCard, UpdateNudge } from "./components/UpdateNudge";
import { StressScene } from "./render/stressScene";
import { CircuitDocument } from "./model/document";
import { PALETTE, compPins, compSpec } from "./editor/catalog";
import { buildDemoDoc } from "./editor/demoCircuit";
import { buildMockDemoDoc } from "./editor/mockDemoCircuit";
import { getCore } from "./ipc";
import { SimController } from "./sim/controller";
import type { CompId, WireValue } from "./ipc/types";

/**
 * App shell: header + sim transport + palette + canvas + watch panel +
 * statusbar. The circuit editor is the default view; the U1 stress harness
 * stays reachable at ?stress=1, the U4 visual showcase at ?demo=1, and the
 * U5 mock-core demo circuit at ?simdemo=1.
 */
export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const stress = params.has("stress");
  const [stressScene] = useState(() => (stress ? StressScene.generate() : null));
  const [doc] = useState(() => {
    const d = params.has("simdemo")
      ? buildMockDemoDoc()
      : params.has("demo")
        ? buildDemoDoc()
        : CircuitDocument.create("untitled");
    // editor injects pin knowledge so type/attr edits prune dangling wires
    d.pinResolver = (comp) => compPins(comp).map((p) => p.name);
    return d;
  });
  // One sim session per app lifetime (U5). Core is the mock under
  // VITE_MOCK_CORE=1 (dev default), else the Tauri adapter.
  const [sim] = useState(() => new SimController(getCore()));
  const editorRef = useRef<EditorHandle>(null);
  const [status, setStatus] = useState<EditorStatus | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [editingComp, setEditingComp] = useState<string | null>(null);
  const [animate, setAnimate] = useState(true);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const [pathOn, setPathOn] = useState(false);
  const simVersion = useSyncExternalStore(sim.store.subscribe, () => sim.store.getVersion());

  // U7: the observed critical path (top-1) as document component ids.
  const pathIds = useMemo(() => {
    if (!pathOn || !sim.store.loaded) return null;
    const top = sim.store.timing?.top_paths[0];
    if (top === undefined || top.length === 0) return null;
    return top
      .map((idx) => doc.circuit(0).components[idx]?.id)
      .filter((id): id is string => id !== undefined);
  }, [pathOn, sim.store, doc, simVersion]);

  // A fresh load invalidates any path highlight.
  useEffect(() => {
    if (!sim.store.loaded && pathOn) setPathOn(false);
  }, [sim.store, pathOn, simVersion]);

  const toast = useCallback((text: string) => {
    setToasts((t) => [...t, { id: Date.now() + Math.random(), text }]);
  }, []);
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => setToasts((t) => t.slice(1)), 4500);
    return () => clearTimeout(timer);
  }, [toasts]);

  // Reset (U6, DESIGN.md §5.2): fresh engine state; autoload images
  // re-apply — confirmed with a toast naming each reloaded memory.
  const onReset = useCallback(async () => {
    const mems = doc
      .circuit(0)
      .components.filter(
        (c) =>
          (c.type === "mem.ram" || c.type === "mem.rom") &&
          c.name !== undefined &&
          typeof c.attrs?.autoload === "string" &&
          c.attrs.autoload !== "",
      );
    const ok = await sim.load(doc);
    if (ok) {
      toast(
        mems.length > 0
          ? `Reset — reloaded ${mems.map((m) => `${m.name} from ${String(m.attrs?.autoload)}`).join(", ")}`
          : "Reset — circuit reloaded (no autoload memories)",
      );
    }
  }, [doc, sim, toast]);

  const onStatus = useCallback((s: EditorStatus) => setStatus(s), []);

  // DEV hook: e2e reads the document JSON through this.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __circuitDoc?: () => string };
    w.__circuitDoc = () => doc.toJson();
    return () => {
      delete w.__circuitDoc;
    };
  }, [doc]);

  // DEV hook: e2e drives/inspects the sim session through this.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as {
      __sim?: {
        state: () => {
          loaded: boolean;
          running: boolean;
          cycle: number;
          halted: string | null;
          netCount: number;
        };
        load: () => Promise<boolean>;
        poke: (comp: CompId, pin: string, val: WireValue) => Promise<void>;
        memRead: (name: string, addr: number, len: number) => Promise<WireValue[]>;
        memWrite: (name: string, addr: number, values: WireValue[]) => Promise<void>;
      };
    };
    w.__sim = {
      state: () => ({
        loaded: sim.store.loaded,
        running: sim.store.status?.running ?? false,
        cycle: sim.store.cycle,
        halted: sim.store.halted?.reason ?? null,
        netCount: sim.store.netValues.size,
      }),
      load: () => sim.load(doc),
      poke: (comp, pin, val) => sim.poke(comp, pin, val),
      memRead: (name, addr, len) => sim.memRead(name, addr, len),
      memWrite: (name, addr, values) => sim.memWrite(name, addr, values),
    };
    return () => {
      delete w.__sim;
    };
  }, [sim, doc]);

  // "?" toggles the shortcut overlay; Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "?") setShowHelp((v) => !v);
      if (e.key === "Escape") setShowHelp(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app" data-theme={theme}>
      <header className="app-header">
        <h1>CircuitSim++</h1>
        <div className="header-actions">
          {!stress && (
            <>
              <button
                className="secondary"
                disabled={status?.canUndo === false}
                onClick={() => editorRef.current?.undo()}
                title={status?.undoLabel ? `Undo ${status.undoLabel}` : "Undo"}
              >
                Undo
              </button>
              <button
                className="secondary"
                disabled={status?.canRedo === false}
                onClick={() => editorRef.current?.redo()}
                title={status?.redoLabel ? `Redo ${status.redoLabel}` : "Redo"}
              >
                Redo
              </button>
              <button className="secondary" onClick={() => editorRef.current?.rotate()}>
                Rotate (R)
              </button>
              <button className="secondary" onClick={() => editorRef.current?.deleteSelection()}>
                Delete (Del)
              </button>
            </>
          )}
          {stress && (
            <button onClick={() => setAnimate(!animate)}>
              {animate ? "Pause states" : "Animate states"}
            </button>
          )}
          <button className="secondary" onClick={() => setShowHelp(true)}>
            ?
          </button>
          <button className="secondary" onClick={() => setShowAbout(true)}>
            About
          </button>
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Light" : "Dark"} theme
          </button>
        </div>
      </header>
      {!stress && (
        <SimBar
          ctl={sim}
          doc={doc}
          onReset={onReset}
          pathOn={pathOn}
          onTogglePath={() => setPathOn((v) => !v)}
        />
      )}
      <main className="app-main">
        {stress && stressScene !== null ? (
          <div className="editor-wrap">
            <StressCanvas scene={stressScene} themeName={theme} animate={animate} />
          </div>
        ) : (
          <>
            <aside className="palette">
              {PALETTE.map((g) => (
                <div className="palette-group" key={g.group}>
                  <div className="palette-group-title">{g.group}</div>
                  {g.types.map((t) => (
                    <button
                      key={t}
                      className={`palette-item${status?.placing === t ? " active" : ""}`}
                      draggable
                      onClick={() => editorRef.current?.startPlacing(t)}
                      onDragStart={(e) => e.dataTransfer.setData("text/x-csx-type", t)}
                      title={`${t} — click, then click the canvas to place (R rotates, Esc cancels)`}
                    >
                      {compSpec(t).caption({})}
                    </button>
                  ))}
                </div>
              ))}
            </aside>
            <div className="editor-wrap">
              <EditorCanvas
                ref={editorRef}
                doc={doc}
                themeName={theme}
                onStatus={onStatus}
                onEditComponent={setEditingComp}
                sim={sim}
                pathIds={pathIds}
              />
            </div>
            <WatchPanel ctl={sim} />
          </>
        )}
      </main>
      <footer className="app-statusbar">
        <span>
          {doc.name}
          {status?.dirty ? " •" : ""}
        </span>
        {status?.placing && (
          <span>placing {status.placing} — click to drop, R rotate, Esc cancel</span>
        )}
        {status !== null && status.selection > 0 && <span>{status.selection} selected</span>}
        {status?.cursor && (
          <span>
            ({status.cursor.x.toFixed(1)}, {status.cursor.y.toFixed(1)})
          </span>
        )}
        <span className="statusbar-hint">press ? for shortcuts</span>
      </footer>
      {editingComp !== null && (
        <PropertiesDialog doc={doc} compId={editingComp} onClose={() => setEditingComp(null)} />
      )}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div className="toast" key={t.id} role="status">
            {t.text}
          </div>
        ))}
      </div>
      {showAbout && <AboutCard onClose={() => setShowAbout(false)} />}
      <UpdateNudge />
      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-card" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard &amp; mouse</h2>
            <table>
              <tbody>
                <tr>
                  <td>Click a pin</td>
                  <td>start a wire (clicks place bends)</td>
                </tr>
                <tr>
                  <td>Drop on a wire</td>
                  <td>finish wire with a junction (dot)</td>
                </tr>
                <tr>
                  <td>Drag from a wire</td>
                  <td>start a wire from a junction</td>
                </tr>
                <tr>
                  <td>Click component / wire</td>
                  <td>select (Shift toggles)</td>
                </tr>
                <tr>
                  <td>Drag component</td>
                  <td>move selection (wires follow)</td>
                </tr>
                <tr>
                  <td>Drag empty space</td>
                  <td>box select</td>
                </tr>
                <tr>
                  <td>R</td>
                  <td>rotate selection / placement ghost</td>
                </tr>
                <tr>
                  <td>Del / Backspace</td>
                  <td>delete selection</td>
                </tr>
                <tr>
                  <td>Ctrl+C / Ctrl+V</td>
                  <td>copy / paste</td>
                </tr>
                <tr>
                  <td>Ctrl+A</td>
                  <td>select all</td>
                </tr>
                <tr>
                  <td>Ctrl+Z / Ctrl+Y</td>
                  <td>undo / redo</td>
                </tr>
                <tr>
                  <td>Esc / right-click</td>
                  <td>cancel wiring / placement / gesture</td>
                </tr>
                <tr>
                  <td>Wheel</td>
                  <td>zoom at cursor</td>
                </tr>
                <tr>
                  <td>Space+drag / middle-drag</td>
                  <td>pan</td>
                </tr>
              </tbody>
            </table>
            <p className="help-dismiss">click anywhere or press Esc to dismiss</p>
          </div>
        </div>
      )}
    </div>
  );
}
