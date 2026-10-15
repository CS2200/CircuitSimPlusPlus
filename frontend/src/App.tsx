import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import StressCanvas from "./components/StressCanvas";
import CompIcon, { PaletteGroupIcon } from "./components/CompIcon";
import EditorCanvas, { type EditorHandle, type EditorStatus } from "./components/EditorCanvas";
import {
  HelpIcon,
  InfoIcon,
  MoonIcon,
  RedoIcon,
  SettingsIcon,
  SunIcon,
  UndoIcon,
} from "./components/icons";
import InspectorPanel from "./components/InspectorPanel";
import MenuBar, { type MenuDef } from "./components/MenuBar";
import NameDialog from "./components/NameDialog";
import ResizeHandle from "./components/ResizeHandle";
import RightDock, { type DockTab } from "./components/RightDock";
import SettingsDialog from "./components/SettingsDialog";
import SheetTabs from "./components/SheetTabs";
import SimBar from "./components/SimBar";
import WatchPanel from "./components/WatchPanel";
import { AboutCard, UpdateNudge } from "./components/UpdateNudge";
import { StressScene } from "./render/stressScene";
import { CircuitDocument } from "./model/document";
import { PALETTE, compPins, compSpec } from "./editor/catalog";
import { compLayout } from "./editor/layout";
import { buildDemoDoc } from "./editor/demoCircuit";
import { buildMockDemoDoc } from "./editor/mockDemoCircuit";
import { getCore } from "./ipc";
import { SimController } from "./sim/controller";
import { baseName, downloadTextFile, isTauri, openCircuitFile, pickSavePath } from "./files";
import { DEFAULT_PANEL_WIDTHS, loadPanelWidth, savePanelWidth, type PanelId } from "./panels";
import { loadBoolPref, PREF_PULSES, PREF_UPDATE_CHECK, saveBoolPref } from "./prefs";
import {
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  isLightTheme,
  loadAccentPref,
  loadThemePref,
  saveAccentPref,
  saveThemePref,
  type AccentId,
  type ThemeId,
} from "./theme";
import type { CompId, TimingUpdate, ViolationKind, WireValue } from "./ipc/types";

/** Stable empty selection while no status report has arrived yet. */
const EMPTY_SELECTION: readonly string[] = [];

/** Fresh docs get the editor's pin knowledge so type/attr edits prune dangling wires. */
function initDoc(d: CircuitDocument): CircuitDocument {
  d.pinResolver = (comp) => compPins(comp, d.circuits).map((p) => p.name);
  // Pin geometry (position + facing): lets rotation re-anchor glued wire
  // ends and re-stub them along the new facing (wire-routing pass).
  d.pinGeometry = (comp, pin) => {
    const p = compLayout(comp, d.circuits).pins.find((x) => x.name === pin);
    return p === undefined ? null : { pos: [p.x, p.y], facing: p.facing };
  };
  return d;
}

/**
 * App shell: VSCode-style top bar (menus + action icons) + sim transport +
 * palette + canvas + right dock (Inspector / Watch) + statusbar. The
 * circuit editor is the default view; the U1 stress harness stays reachable
 * at ?stress=1, the U4 visual showcase at ?demo=1, and the U5 mock-core
 * demo circuit at ?simdemo=1.
 */
export default function App() {
  // Theme is a persisted per-machine preference (UI_OVERHAUL §2); OLED is
  // the default for fresh installs.
  const [theme, setTheme] = useState<ThemeId>(loadThemePref);
  // Appearance/behavior preferences (Settings): accent color, canvas pulse
  // animation, startup update check — per machine, all persisted.
  const [accent, setAccent] = useState<AccentId>(loadAccentPref);
  const [pulsesOn, setPulsesOn] = useState(() => loadBoolPref(PREF_PULSES, true));
  const [updateCheckOn, setUpdateCheckOn] = useState(() => loadBoolPref(PREF_UPDATE_CHECK, true));
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const stress = params.has("stress");
  const [stressScene] = useState(() => (stress ? StressScene.generate() : null));
  const [doc, setDoc] = useState(() =>
    initDoc(
      params.has("simdemo")
        ? buildMockDemoDoc()
        : params.has("demo")
          ? buildDemoDoc()
          : CircuitDocument.create("untitled"),
    ),
  );
  // One sim session per app lifetime (U5). Core is the mock under
  // VITE_MOCK_CORE=1 (dev default), else the Tauri adapter.
  const [sim] = useState(() => new SimController(getCore()));
  const editorRef = useRef<EditorHandle>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<EditorStatus | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dockTab, setDockTab] = useState<DockTab>("watch");
  // Palette activity rail (UI_OVERHAUL §8): which component group the body shows.
  const [paletteGroup, setPaletteGroup] = useState<string>(PALETTE[0].group);
  // Resizable side panels (UI_OVERHAUL §7): live widths, persisted on
  // release; defaults match the pre-resize layout.
  const [panelWidths, setPanelWidths] = useState<Record<PanelId, number>>(() => ({
    palette: loadPanelWidth("palette"),
    dock: loadPanelWidth("dock"),
  }));
  const resizePanel = useCallback((id: PanelId, width: number) => {
    setPanelWidths((prev) => (prev[id] === width ? prev : { ...prev, [id]: width }));
  }, []);
  const commitPanel = useCallback(
    (id: PanelId, width: number) => {
      resizePanel(id, width);
      savePanelWidth(id, width);
    },
    [resizePanel],
  );
  const [animate, setAnimate] = useState(true);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const [pathOn, setPathOn] = useState(false);
  // File state: real path in the Tauri shell; a bare file name after a
  // browser-mode open/download (browsers never expose real paths).
  const [filePath, setFilePath] = useState<string | null>(null);
  // Current sheet (circuit) index — subcircuits live on their own sheets.
  const [sheet, setSheet] = useState(0);
  // Sim clock speed; lifted from SimBar so the Simulation menu shares it.
  const [hzExp, setHzExp] = useState(10); // hz = 10^(exp/10)
  const hz = Math.round(10 ** (hzExp / 10));
  const [nameDialog, setNameDialog] = useState<{
    title: string;
    initial: string;
    submitLabel?: string;
    onSubmit: (value: string) => void;
  } | null>(null);
  const simVersion = useSyncExternalStore(sim.store.subscribe, () => sim.store.getVersion());

  // Current sheet name (safe while a doc/sheet swap is mid-render).
  const sheetName = doc.circuits[sheet]?.name;

  // Palette rail groups (UI_OVERHAUL §8): Subcircuits only exists while the
  // document has more than one circuit; if the active group disappears the
  // body falls back to the first group. Computed inline — the document is
  // mutated in place, so there is no identity to memoize on.
  const paletteGroups = PALETTE.map((g) => g.group);
  if (doc.circuits.length > 1) paletteGroups.push("Subcircuits");
  const activePaletteGroup = paletteGroups.includes(paletteGroup) ? paletteGroup : PALETTE[0].group;

  // Preference persistence (best-effort; non-fatal without storage).
  useEffect(() => {
    saveThemePref(theme);
  }, [theme]);
  useEffect(() => {
    saveAccentPref(accent);
  }, [accent]);
  useEffect(() => {
    saveBoolPref(PREF_PULSES, pulsesOn);
  }, [pulsesOn]);
  useEffect(() => {
    saveBoolPref(PREF_UPDATE_CHECK, updateCheckOn);
  }, [updateCheckOn]);

  // Light/dark icon toggle: flips to the light side and back to whatever
  // theme was last used on the dark side (not a hard-coded pair).
  const lastByMode = useRef<Record<"light" | "dark", ThemeId>>({
    light: "light",
    dark: DEFAULT_THEME,
  });
  useEffect(() => {
    lastByMode.current[isLightTheme(theme) ? "light" : "dark"] = theme;
  }, [theme]);
  const toggleLightDark = useCallback(() => {
    setTheme(isLightTheme(theme) ? lastByMode.current.dark : lastByMode.current.light);
  }, [theme]);
  const resetAppearance = useCallback(() => {
    setTheme(DEFAULT_THEME);
    setAccent(DEFAULT_ACCENT);
    setPulsesOn(true);
    setUpdateCheckOn(true);
  }, []);

  // Right dock (UI_OVERHAUL §3.2): exactly one selected component opens the
  // Inspector; an emptied selection hands the dock back to Watch.
  const selectedComps = status?.selectedComponents ?? EMPTY_SELECTION;
  const inspectorCompId = selectedComps.length === 1 ? selectedComps[0] : null;
  const prevInspectorRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevInspectorRef.current;
    prevInspectorRef.current = inspectorCompId;
    if (inspectorCompId !== null && prev === null) setDockTab("inspector");
    else if (inspectorCompId === null && prev !== null) setDockTab("watch");
  }, [inspectorCompId]);

  // U7: the observed critical path (top-1) as document component ids —
  // only when its circuit is the current sheet (contract v1.1 filter).
  const pathIds = useMemo(() => {
    if (!pathOn || !sim.store.loaded) return null;
    return sim.topPathIds(sheetName);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- simVersion invalidates the mutable store
  }, [pathOn, sim, doc, sheetName, simVersion]);

  // U7: setup/hold violation markers for the current sheet.
  const violationMarkers = useMemo(() => {
    if (!sim.store.loaded || sim.store.timing === null) return null;
    return sim.violationMarkers(sheetName);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- simVersion invalidates the mutable store
  }, [sim, doc, sheetName, simVersion]);

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
  // re-apply — confirmed with a toast naming each reloaded memory. With
  // nothing loaded yet, "reset" IS the first load (a fresh power-on) —
  // never surface the backend's "no circuit loaded" error to the user.
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
    try {
      if (!sim.store.loaded) {
        const ok = await sim.load(doc);
        if (ok) toast("Loaded — fresh power-on state");
        return; // load errors already surface in the sim banner
      }
      await sim.reset();
      toast(
        mems.length > 0
          ? `Reset — reloaded ${mems.map((m) => `${m.name} from ${String(m.attrs?.autoload)}`).join(", ")}`
          : "Reset — fresh power-on state (no autoload memories)",
      );
    } catch (err) {
      toast(`Reset failed: ${String(err)}`);
    }
  }, [doc, sim, toast]);

  const onStatus = useCallback((s: EditorStatus) => setStatus(s), []);

  // ---- file operations (File menu) ----

  /** Replace the editor document (New/Open); the sim engine is re-synced by the caller. */
  const adoptDoc = useCallback((d: CircuitDocument, path: string | null) => {
    setDoc(d);
    setFilePath(path);
    setSheet(0);
  }, []);

  const confirmDiscard = useCallback(() => {
    if (!doc.dirty) return true;
    return window.confirm(`Discard unsaved changes to ${filePath ?? doc.name}?`);
  }, [doc, filePath]);

  const onNew = useCallback(() => {
    if (!confirmDiscard()) return;
    sim.unload();
    adoptDoc(initDoc(CircuitDocument.create("untitled")), null);
    toast("New circuit");
  }, [confirmDiscard, adoptDoc, sim, toast]);

  const onOpen = useCallback(async () => {
    if (!confirmDiscard()) return;
    let opened;
    try {
      opened = await openCircuitFile();
    } catch (err) {
      toast(`Open failed: ${String(err)}`);
      return;
    }
    if (opened === null) return; // cancelled
    let d: CircuitDocument;
    try {
      d = initDoc(CircuitDocument.fromJson(opened.text));
    } catch (err) {
      toast(`Open failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    adoptDoc(d, opened.path ?? opened.name);
    // Engine side: path-load in the shell (autoloads resolve next to the
    // file, DESIGN.md §5.2); bytes-load in the browser/mock. Failures land
    // in the sim banner via the store.
    const load = opened.path !== null ? sim.loadFromPath(d, opened.path) : sim.load(d);
    void load.then((ok) => {
      if (ok) toast(`Opened ${opened.name}`);
    });
  }, [confirmDiscard, adoptDoc, sim, toast]);

  const doSave = useCallback(
    async (path: string) => {
      try {
        const res = await sim.save(doc, path);
        if (!res.ok) {
          toast(`Save failed: ${res.errors[0]?.message ?? "unknown error"}`);
          return;
        }
        doc.markClean();
        setFilePath(path);
        editorRef.current?.refresh(); // re-report the dirty flag
        toast(`Saved ${baseName(path)}`);
      } catch (err) {
        toast(`Save failed: ${String(err)}`);
      }
    },
    [doc, sim, toast],
  );

  const onSaveAs = useCallback(() => {
    const suggested = `${doc.name}.csx`;
    if (isTauri()) {
      void pickSavePath(suggested, filePath !== null && filePath.includes("/") ? filePath : null)
        .then((path) => {
          if (path !== null) void doSave(path);
        })
        .catch((err) => toast(`Save failed: ${String(err)}`));
    } else {
      // The browser fallback cannot write files — it downloads instead.
      downloadTextFile(suggested, doc.toJson());
      doc.markClean();
      setFilePath(doc.name);
      editorRef.current?.refresh();
      toast(`Downloaded ${suggested}`);
    }
  }, [doc, filePath, doSave, toast]);

  const onSave = useCallback(() => {
    // Only the Tauri shell can write to a known path; outside it Save is
    // always Save-As (a download).
    if (isTauri() && filePath !== null && filePath.includes("/")) {
      void doSave(filePath);
    } else {
      onSaveAs();
    }
  }, [filePath, doSave, onSaveAs]);

  // ---- sheet (subcircuit) operations (Subcircuits menu) ----

  /** Right-click a subcircuit instance → jump to its definition tab. */
  const onOpenSubcircuit = useCallback(
    (circuit: string) => {
      const idx = doc.circuitIdxByName(circuit);
      if (idx >= 0) setSheet(idx);
      else toast(`Subcircuit "${circuit}" is not in this file`);
    },
    [doc, toast],
  );

  const onNewSheet = useCallback(() => {
    setNameDialog({
      title: "New subcircuit",
      initial: `sub${doc.circuits.length}`,
      submitLabel: "Create",
      onSubmit: (name) => {
        setNameDialog(null);
        try {
          const idx = doc.addCircuit(name);
          setSheet(idx);
          editorRef.current?.refresh();
        } catch (err) {
          toast(String(err instanceof Error ? err.message : err));
        }
      },
    });
  }, [doc, toast]);

  const onRenameSheet = useCallback(
    (idx: number) => {
      const current = doc.circuit(idx).name;
      setNameDialog({
        title: `Rename "${current}"`,
        initial: current,
        submitLabel: "Rename",
        onSubmit: (name) => {
          setNameDialog(null);
          try {
            doc.renameCircuit(idx, name);
            editorRef.current?.refresh();
          } catch (err) {
            toast(String(err instanceof Error ? err.message : err));
          }
        },
      });
    },
    [doc, toast],
  );

  // ---- simulation menu commands ----

  /** Menu mirror of SimBar's load-then-command guard; errors toast. */
  const simCmd = useCallback(
    async (cmd: () => Promise<void>) => {
      try {
        if (!sim.store.loaded) {
          const ok = await sim.load(doc);
          if (!ok) return; // load errors already surface in the sim banner
        }
        await cmd();
      } catch (err) {
        toast(String(err));
      }
    },
    [sim, doc, toast],
  );

  const onRunTo = useCallback(() => {
    setNameDialog({
      title: "Run to cycle",
      initial: String(Math.max(sim.store.cycle + 100, 100)),
      submitLabel: "Run",
      onSubmit: (value) => {
        setNameDialog(null);
        const cycle = Number(value);
        if (!Number.isInteger(cycle) || cycle < 0) {
          toast(`Run to: "${value}" is not a non-negative integer cycle`);
          return;
        }
        void simCmd(() => sim.runUntil(cycle));
      },
    });
  }, [sim, simCmd, toast]);

  // ---- menus ----

  const menus: MenuDef[] = useMemo(() => {
    const mode = sim.store.status?.mode ?? "delay";
    const speedPresets = [1, 10, 100, 1_000, 10_000, 100_000];
    return [
      {
        label: "File",
        items: [
          { label: "New Circuit", onSelect: onNew },
          { label: "Open…", shortcut: "Ctrl+O", onSelect: () => void onOpen() },
          { kind: "sep" },
          { label: "Save", shortcut: "Ctrl+S", onSelect: onSave },
          { label: "Save As…", shortcut: "Ctrl+Shift+S", onSelect: onSaveAs },
        ],
      },
      {
        label: "Edit",
        items: [
          {
            label: "Undo",
            shortcut: "Ctrl+Z",
            disabled: status?.canUndo === false,
            onSelect: () => editorRef.current?.undo(),
          },
          {
            label: "Redo",
            shortcut: "Ctrl+Shift+Z",
            disabled: status?.canRedo === false,
            onSelect: () => editorRef.current?.redo(),
          },
          { kind: "sep" },
          {
            label: "Copy",
            shortcut: "Ctrl+C",
            disabled: (status?.selection ?? 0) === 0,
            onSelect: () => editorRef.current?.copy(),
          },
          { label: "Paste", shortcut: "Ctrl+V", onSelect: () => editorRef.current?.paste() },
          { kind: "sep" },
          {
            label: "Rotate",
            shortcut: "R",
            disabled: (status?.selection ?? 0) === 0,
            onSelect: () => editorRef.current?.rotate(),
          },
          {
            label: "Delete",
            shortcut: "Del",
            disabled: (status?.selection ?? 0) === 0,
            onSelect: () => editorRef.current?.deleteSelection(),
          },
          { kind: "sep" },
          {
            label: "Select All",
            shortcut: "Ctrl+A",
            onSelect: () => editorRef.current?.selectAll(),
          },
        ],
      },
      {
        label: "Simulation",
        items: [
          {
            label: "Step tick",
            shortcut: "Ctrl+J",
            onSelect: () => void simCmd(() => sim.stepTick()),
          },
          { label: "Step cycle", onSelect: () => void simCmd(() => sim.stepCycle()) },
          { label: "Run to cycle…", onSelect: onRunTo },
          {
            label: "Reset (autoload re-applies)",
            shortcut: "Ctrl+R",
            onSelect: () => void onReset(),
          },
          { kind: "sep" },
          ...speedPresets.map((p) => ({
            label: p >= 1000 ? `${p / 1000} kHz` : `${p} Hz`,
            radio: true,
            checked: hz === p,
            onSelect: () => setHzExp(Math.round(10 * Math.log10(p))),
          })),
          { kind: "sep" },
          {
            label: "Delay-aware mode (teaching/grading)",
            radio: true,
            checked: mode === "delay",
            onSelect: () => void simCmd(() => sim.setMode("delay")),
          },
          {
            label: "Zero-delay mode (fast/debug)",
            radio: true,
            checked: mode === "zero",
            onSelect: () => void simCmd(() => sim.setMode("zero")),
          },
          { kind: "sep" },
          {
            label: "Highlight critical path",
            checked: pathOn,
            disabled: sim.store.timing === null,
            onSelect: () => setPathOn((v) => !v),
          },
        ],
      },
      {
        label: "Subcircuits",
        items: [
          { label: "New subcircuit…", onSelect: onNewSheet },
          { label: "Rename current…", onSelect: () => onRenameSheet(sheet) },
        ],
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- simVersion invalidates the mutable store
  }, [
    doc,
    sheet,
    hz,
    pathOn,
    status,
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onNewSheet,
    onRenameSheet,
    onRunTo,
    onReset,
    sim,
    simCmd,
    simVersion,
  ]);

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
        timing: () => TimingUpdate | null;
        violationMarkers: () => { compId: string; kind: ViolationKind; detail: string }[];
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
      timing: () => sim.store.timing,
      violationMarkers: () => sim.violationMarkers(),
    };
    return () => {
      delete w.__sim;
    };
  }, [sim, doc]);

  // "?" toggles the shortcut overlay; Escape closes it. Mod+O/S/Shift+S are
  // the file shortcuts (Ctrl+N is browser-reserved — New is menu-only).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void onOpen();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) onSaveAs();
        else onSave();
        return;
      }
      if (e.key === "?") setShowHelp((v) => !v);
      if (e.key === "Escape") setShowHelp(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen, onSave, onSaveAs]);

  return (
    <div className="app" data-theme={theme} data-accent={accent}>
      <div className="topbar">
        <h1 className="sr-only">CircuitSim++</h1>
        {!stress && <MenuBar menus={menus} pathLabel={filePath} />}
        {stress && <span className="menubar-path">stress harness — ?stress=1</span>}
        <div className="topbar-actions">
          {stress && (
            <button className="secondary" onClick={() => setAnimate(!animate)}>
              {animate ? "Pause states" : "Animate states"}
            </button>
          )}
          {!stress && (
            <>
              <button
                className="icon-btn"
                aria-label="Undo"
                title={status?.undoLabel ? `Undo ${status.undoLabel}` : "Undo"}
                disabled={status?.canUndo === false}
                onClick={() => editorRef.current?.undo()}
              >
                <UndoIcon />
              </button>
              <button
                className="icon-btn"
                aria-label="Redo"
                title={status?.redoLabel ? `Redo ${status.redoLabel}` : "Redo"}
                disabled={status?.canRedo === false}
                onClick={() => editorRef.current?.redo()}
              >
                <RedoIcon />
              </button>
            </>
          )}
          <span className="topbar-sep" aria-hidden="true" />
          <button
            className="icon-btn"
            aria-label={isLightTheme(theme) ? "Switch to dark theme" : "Switch to light theme"}
            title={isLightTheme(theme) ? "Switch to dark theme" : "Switch to light theme"}
            onClick={toggleLightDark}
          >
            {isLightTheme(theme) ? <MoonIcon /> : <SunIcon />}
          </button>
          <button
            className="icon-btn"
            aria-label="Help"
            title="Keyboard & mouse"
            onClick={() => setShowHelp(true)}
          >
            <HelpIcon />
          </button>
          <button
            className="icon-btn"
            aria-label="About"
            title="About CircuitSim++"
            onClick={() => setShowAbout(true)}
          >
            <InfoIcon />
          </button>
          <button
            className="icon-btn"
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon />
          </button>
        </div>
      </div>
      {!stress && (
        <SimBar
          ctl={sim}
          doc={doc}
          onReset={onReset}
          pathOn={pathOn}
          onTogglePath={() => setPathOn((v) => !v)}
          hzExp={hzExp}
          onHzExp={setHzExp}
        />
      )}
      {!stress && (
        <SheetTabs
          sheets={doc.circuits.map((c) => c.name)}
          active={sheet}
          onSwitch={setSheet}
          onNew={onNewSheet}
          onRename={onRenameSheet}
        />
      )}
      <main className="app-main">
        {stress && stressScene !== null ? (
          <div className="editor-wrap">
            <StressCanvas scene={stressScene} themeName={`${theme}|${accent}`} animate={animate} />
          </div>
        ) : (
          <>
            <aside className="palette" style={{ width: panelWidths.palette }}>
              <div
                className="palette-rail"
                role="tablist"
                aria-orientation="vertical"
                aria-label="Component groups"
                ref={railRef}
              >
                {paletteGroups.map((g, i) => (
                  <button
                    key={g}
                    role="tab"
                    data-group={g}
                    className={`palette-rail-btn${activePaletteGroup === g ? " active" : ""}`}
                    aria-selected={activePaletteGroup === g}
                    tabIndex={activePaletteGroup === g ? 0 : -1}
                    title={g}
                    onMouseEnter={() => setPaletteGroup(g)}
                    onFocus={() => setPaletteGroup(g)}
                    onClick={() => setPaletteGroup(g)}
                    onKeyDown={(e) => {
                      const dir = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
                      if (dir === 0) return;
                      e.preventDefault();
                      const next =
                        paletteGroups[(i + dir + paletteGroups.length) % paletteGroups.length];
                      setPaletteGroup(next);
                      railRef.current
                        ?.querySelector<HTMLButtonElement>(`[data-group="${next}"]`)
                        ?.focus();
                    }}
                  >
                    <PaletteGroupIcon group={g} />
                  </button>
                ))}
              </div>
              <div className="palette-body">
                <div className="palette-group-title">{activePaletteGroup}</div>
                <div className="palette-group" role="tabpanel" aria-label={activePaletteGroup}>
                  {activePaletteGroup === "Subcircuits"
                    ? doc.circuits.map(
                        (c, i) =>
                          i !== sheet && (
                            <button
                              key={c.name}
                              className={`palette-item${status?.placing === "subcircuit" ? " active" : ""}`}
                              draggable
                              onClick={(e) =>
                                editorRef.current?.startPlacing("subcircuit", e.shiftKey, {
                                  circuit: c.name,
                                })
                              }
                              onDragStart={(e) => {
                                e.dataTransfer.setData("text/x-csx-type", "subcircuit");
                                e.dataTransfer.setData(
                                  "text/x-csx-attrs",
                                  JSON.stringify({ circuit: c.name }),
                                );
                              }}
                              title={`Place an instance of "${c.name}" — its interface is the circuit's named pin components`}
                            >
                              <CompIcon type="subcircuit" />
                              <span className="palette-item-label">{c.name}</span>
                            </button>
                          ),
                      )
                    : (PALETTE.find((g) => g.group === activePaletteGroup)?.types ?? []).map(
                        (t) => (
                          <button
                            key={t}
                            className={`palette-item${status?.placing === t ? " active" : ""}`}
                            draggable
                            onClick={(e) => editorRef.current?.startPlacing(t, e.shiftKey)}
                            onDragStart={(e) => e.dataTransfer.setData("text/x-csx-type", t)}
                            title={`${t} — click, then click the canvas to place once (Shift-click to place many; R rotates, Esc cancels)`}
                          >
                            <CompIcon type={t} />
                            <span className="palette-item-label">{compSpec(t).caption({})}</span>
                          </button>
                        ),
                      )}
                </div>
              </div>
            </aside>
            <div className="editor-wrap">
              <EditorCanvas
                ref={editorRef}
                doc={doc}
                themeName={`${theme}|${accent}`}
                sheetIdx={sheet}
                onStatus={onStatus}
                onEditComponent={() => setDockTab("inspector")}
                onOpenSubcircuit={onOpenSubcircuit}
                sim={sim}
                pathIds={pathIds}
                violations={violationMarkers}
                pulsesOn={pulsesOn}
              />
              {/* Panel separators: edge overlays (no layout footprint). */}
              <ResizeHandle
                panel="palette"
                side="left"
                width={panelWidths.palette}
                defaultWidth={DEFAULT_PANEL_WIDTHS.palette}
                onResize={(w) => resizePanel("palette", w)}
                onCommit={(w) => commitPanel("palette", w)}
              />
              <ResizeHandle
                panel="dock"
                side="right"
                width={panelWidths.dock}
                defaultWidth={DEFAULT_PANEL_WIDTHS.dock}
                onResize={(w) => resizePanel("dock", w)}
                onCommit={(w) => commitPanel("dock", w)}
              />
            </div>
            <RightDock
              tab={dockTab}
              onTab={setDockTab}
              width={panelWidths.dock}
              inspector={
                <InspectorPanel
                  doc={doc}
                  compId={inspectorCompId}
                  selectionCount={selectedComps.length}
                  circuitIdx={sheet}
                  circuits={doc.circuits.filter((_, i) => i !== sheet).map((c) => c.name)}
                  onEdit={() => editorRef.current?.refresh()}
                />
              }
              watch={<WatchPanel ctl={sim} />}
            />
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
      {nameDialog !== null && (
        <NameDialog
          title={nameDialog.title}
          initial={nameDialog.initial}
          submitLabel={nameDialog.submitLabel}
          onSubmit={nameDialog.onSubmit}
          onCancel={() => setNameDialog(null)}
        />
      )}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div className="toast" key={t.id} role="status">
            {t.text}
          </div>
        ))}
      </div>
      {showAbout && <AboutCard onClose={() => setShowAbout(false)} />}
      {settingsOpen && (
        <SettingsDialog
          theme={theme}
          accent={accent}
          pulsesOn={pulsesOn}
          updateCheckOn={updateCheckOn}
          onTheme={setTheme}
          onAccent={setAccent}
          onPulses={setPulsesOn}
          onUpdateCheck={setUpdateCheckOn}
          onReset={resetAppearance}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <UpdateNudge enabled={updateCheckOn} />
      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-card" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard &amp; mouse</h2>
            <table>
              <tbody>
                <tr>
                  <td>Click a pin</td>
                  <td>start a wire (each click plants a bend)</td>
                </tr>
                <tr>
                  <td>X (while wiring)</td>
                  <td>flip the corner direction</td>
                </tr>
                <tr>
                  <td>Drag a wire bend</td>
                  <td>move that corner point</td>
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
                  <td>Inspector (right dock)</td>
                  <td>edits the selected component — applies live</td>
                </tr>
                <tr>
                  <td>Drag component</td>
                  <td>move selection (wires follow)</td>
                </tr>
                <tr>
                  <td>↻ above a selection</td>
                  <td>rotate it (same as R)</td>
                </tr>
                <tr>
                  <td>Drag empty space</td>
                  <td>box select (Ctrl/Shift adds)</td>
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
                  <td>Ctrl+O</td>
                  <td>open a .csx circuit</td>
                </tr>
                <tr>
                  <td>Ctrl+S / Ctrl+Shift+S</td>
                  <td>save / save as</td>
                </tr>
                <tr>
                  <td>Ctrl+Z / Ctrl+Y</td>
                  <td>undo / redo</td>
                </tr>
                <tr>
                  <td>Ctrl+J</td>
                  <td>sim: step one tick</td>
                </tr>
                <tr>
                  <td>Ctrl+K</td>
                  <td>sim: run (until halt) / pause</td>
                </tr>
                <tr>
                  <td>Ctrl+R</td>
                  <td>sim: reset (autoload re-applies)</td>
                </tr>
                <tr>
                  <td>Shift+click wire</td>
                  <td>show the value on that wire</td>
                </tr>
                <tr>
                  <td>Shift+click palette</td>
                  <td>place many (Esc to stop)</td>
                </tr>
                <tr>
                  <td>Esc / right-click</td>
                  <td>cancel wiring / placement / gesture</td>
                </tr>
                <tr>
                  <td>Right-click a subcircuit</td>
                  <td>jump to its definition tab</td>
                </tr>
                <tr>
                  <td>Wheel</td>
                  <td>zoom at cursor</td>
                </tr>
                <tr>
                  <td>Right-drag / Shift+drag</td>
                  <td>pan (a click without moving still cancels / selects)</td>
                </tr>
                <tr>
                  <td>Middle-drag / Space+drag</td>
                  <td>pan</td>
                </tr>
                <tr>
                  <td>Panel edges</td>
                  <td>drag to resize the palette / dock (double-click resets)</td>
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
