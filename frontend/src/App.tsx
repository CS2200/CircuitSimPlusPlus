import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import StressCanvas from "./components/StressCanvas";
import EditorCanvas, { type EditorHandle, type EditorStatus } from "./components/EditorCanvas";
import { StressScene } from "./render/stressScene";
import { CircuitDocument } from "./model/document";
import { PALETTE, compSpec } from "./editor/catalog";

/**
 * App shell: header + palette + canvas + statusbar. The circuit editor is
 * the default view; the U1 stress harness stays reachable at ?stress=1 for
 * perf work.
 */
export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const stress = useMemo(() => new URLSearchParams(window.location.search).has("stress"), []);
  const [stressScene] = useState(() => (stress ? StressScene.generate() : null));
  const [doc] = useState(() => CircuitDocument.create("untitled"));
  const editorRef = useRef<EditorHandle>(null);
  const [status, setStatus] = useState<EditorStatus | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [animate, setAnimate] = useState(true);

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
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Light" : "Dark"} theme
          </button>
        </div>
      </header>
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
              <EditorCanvas ref={editorRef} doc={doc} themeName={theme} onStatus={onStatus} />
            </div>
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
