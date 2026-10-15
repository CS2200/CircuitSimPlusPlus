import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import AppHeader from "./components/AppHeader";
import StressCanvas from "./components/StressCanvas";
import CompIcon, { PaletteGroupIcon } from "./components/CompIcon";
import EditorCanvas, { type EditorHandle, type EditorStatus } from "./components/EditorCanvas";
import {
  AppLogoIcon,
  HistoryIcon,
  MoonIcon,
  RedoIcon,
  SunIcon,
  UndoIcon,
} from "./components/icons";
import InspectorPanel from "./components/InspectorPanel";
import MenuBar, { type MenuDef } from "./components/MenuBar";
import NameDialog from "./components/NameDialog";
import HistoryDialog from "./components/HistoryDialog";
import RecoveryDialog from "./components/RecoveryDialog";
import ResizeHandle from "./components/ResizeHandle";
import SaveIndicator, { type SaveState } from "./components/SaveIndicator";
import SettingsDialog from "./components/SettingsDialog";
import SheetTabs from "./components/SheetTabs";
import SimBar from "./components/SimBar";
import { AboutCard, UpdateNudge } from "./components/UpdateNudge";
import { StressScene } from "./render/stressScene";
import { AutosaveController } from "./model/autosave";
import { CircuitDocument } from "./model/document";
import { newDocKey, recoveryStore, type RecoveryMeta } from "./model/recovery";
import { historyStore, type HistoryUsage, type VersionMeta } from "./model/versionStore";
import { PALETTE, compPins, compSpec, defaultAttrs, editableAttrs } from "./editor/catalog";
import { compLayout } from "./editor/layout";
import { buildDemoDoc } from "./editor/demoCircuit";
import { buildMockDemoDoc } from "./editor/mockDemoCircuit";
import { getCore } from "./ipc";
import { SimController } from "./sim/controller";
import {
  baseName,
  isTauri,
  openCircuitFile,
  pickSavePath,
  readFileText,
  saveTextFile,
  statFile,
} from "./files";
import { DEFAULT_PANEL_WIDTHS, loadPanelWidth, savePanelWidth, type PanelId } from "./panels";
import {
  loadBoolPref,
  loadNumPref,
  PREF_AUTOSAVE,
  PREF_AUTOSAVE_FILE,
  PREF_DEFAULT_BITS,
  PREF_DEFAULT_HZ,
  PREF_DEFAULT_INPUTS,
  PREF_GRID,
  PREF_PULSES,
  PREF_SHOW_PERF,
  PREF_SHOW_VALUES,
  PREF_UPDATE_CHECK,
  saveBoolPref,
  saveNumPref,
} from "./prefs";
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
const EMPTY_SELECTION_NUM: readonly number[] = [];

/**
 * A real, writable file path only exists in the Tauri shell (the browser saves
 * downloads and never learns a path).
 */
function realPathOf(path: string | null): string | null {
  return isTauri() && path !== null && path.includes("/") ? path : null;
}

/**
 * Automatic version snapshots coalesce inside this window, so one burst of
 * editing becomes one history entry; an explicit Save always makes a new one.
 */
const VERSION_COALESCE_MS = 60_000;

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
  const [gridOn, setGridOn] = useState(() => loadBoolPref(PREF_GRID, false));
  // Canvas readouts / overlays (Settings → Canvas).
  const [showValues, setShowValues] = useState(() => loadBoolPref(PREF_SHOW_VALUES, true));
  const [showPerf, setShowPerf] = useState(() => loadBoolPref(PREF_SHOW_PERF, false));
  // Placement seeds (Settings → Editing) and the transport's start speed.
  const [defaultBits, setDefaultBits] = useState(() => loadNumPref(PREF_DEFAULT_BITS, 1));
  const [defaultInputs, setDefaultInputs] = useState(() => loadNumPref(PREF_DEFAULT_INPUTS, 2));
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
  // Autosave (autosave, phase 1): a crash-recovery copy 3 s after the last
  // edit, plus — for named files, opt-out — an atomic rewrite of the file.
  const [autosaveOn, setAutosaveOn] = useState(() => loadBoolPref(PREF_AUTOSAVE, true));
  const [autosaveFileOn, setAutosaveFileOn] = useState(() =>
    loadBoolPref(PREF_AUTOSAVE_FILE, true),
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: "clean" });
  const [recoveries, setRecoveries] = useState<RecoveryMeta[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  // Version history (autosave phase 3): the dialog's own little state.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [historySelectedId, setHistorySelectedId] = useState<string | null>(null);
  const [historyPreview, setHistoryPreview] = useState<string | null>(null);
  const [historyUsage, setHistoryUsage] = useState<HistoryUsage | null>(null);
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

  // ---- autosave plumbing (the scheduler itself is created further down) ----
  // Refs mirror the mutable state its host reads at flush time, so the
  // controller never closes over a stale document or path.
  const autosaveRef = useRef<AutosaveController | null>(null);
  const docRef = useRef(doc);
  const filePathRef = useRef(filePath);
  const autosaveOnRef = useRef(autosaveOn);
  const autosaveFileRef = useRef(autosaveFileOn);
  const undoLabelRef = useRef<string | null>(null);
  const docKeyRef = useRef(newDocKey());
  const recoveryKeyRef = useRef<string | null>(null);
  /** Size+mtime we last wrote, for the external-change guard. */
  const lastWriteRef = useRef<{ path: string; mtime_ms: number; size: number } | null>(null);
  /** Set while a disk conflict is unresolved, so we warn only once. */
  const diskConflictRef = useRef(false);

  /** Drop the rolling recovery copy (after a successful save to disk). */
  const discardRecovery = useCallback(async () => {
    const key = recoveryKeyRef.current;
    if (key === null) return;
    recoveryKeyRef.current = null;
    try {
      await recoveryStore().discard(key);
    } catch {
      /* best-effort: a stale recovery copy is harmless */
    }
  }, []);

  /** What the recovery/version stores key this document by. */
  const historyTarget = useCallback(
    (): { path: string | null; docKey: string } => ({
      path: realPathOf(filePathRef.current),
      docKey: docKeyRef.current,
    }),
    [],
  );

  /** Remember what we just wrote, so the guard can spot later external edits. */
  const recordWriteStat = useCallback(async (path: string) => {
    const stat = await statFile(path);
    lastWriteRef.current = stat !== null ? { path, ...stat } : null;
  }, []);

  /**
   * Record the current document as a version. `coalesceMs > 0` folds it into a
   * recent automatic version, so a burst of autosaves becomes one entry.
   * History is a convenience — a failure never blocks the save itself.
   */
  const takeVersion = useCallback(
    async (coalesceMs: number) => {
      const d = docRef.current;
      try {
        await historyStore().snapshot(
          historyTarget(),
          JSON.parse(d.toJson()) as unknown,
          undoLabelRef.current ?? "Edit",
          Date.now(),
          coalesceMs,
        );
      } catch {
        /* best-effort */
      }
    },
    [historyTarget],
  );
  // Sim clock speed; lifted from SimBar so the Simulation menu shares it.
  const [hzExp, setHzExp] = useState(() => loadNumPref(PREF_DEFAULT_HZ, 10)); // hz = 10^(exp/10)
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
    saveBoolPref(PREF_GRID, gridOn);
  }, [gridOn]);
  useEffect(() => {
    saveBoolPref(PREF_SHOW_VALUES, showValues);
  }, [showValues]);
  useEffect(() => {
    saveBoolPref(PREF_SHOW_PERF, showPerf);
  }, [showPerf]);
  useEffect(() => {
    saveNumPref(PREF_DEFAULT_BITS, defaultBits);
  }, [defaultBits]);
  useEffect(() => {
    saveNumPref(PREF_DEFAULT_INPUTS, defaultInputs);
  }, [defaultInputs]);
  useEffect(() => {
    saveNumPref(PREF_DEFAULT_HZ, hzExp);
  }, [hzExp]);
  useEffect(() => {
    saveBoolPref(PREF_UPDATE_CHECK, updateCheckOn);
  }, [updateCheckOn]);
  useEffect(() => {
    saveBoolPref(PREF_AUTOSAVE, autosaveOn);
  }, [autosaveOn]);
  useEffect(() => {
    saveBoolPref(PREF_AUTOSAVE_FILE, autosaveFileOn);
  }, [autosaveFileOn]);

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
    setGridOn(false);
    setShowValues(true);
    setShowPerf(false);
    setDefaultBits(1);
    setDefaultInputs(2);
    setHzExp(10);
    setUpdateCheckOn(true);
    setAutosaveOn(true);
    setAutosaveFileOn(true);
  }, []);

  // Inspector (UI_OVERHAUL §3.2): exactly one selected component — or one
  // selected wire — drives the right dock. The Watch tab is retired for now
  // (UI_OVERHAUL §11), so the dock is Inspector-only.
  const selectedComps = status?.selectedComponents ?? EMPTY_SELECTION;
  const selectedWires = status?.selectedWires ?? EMPTY_SELECTION_NUM;
  const inspectorCompId = selectedComps.length === 1 ? selectedComps[0] : null;
  const inspectorWireIdx =
    selectedComps.length === 0 && selectedWires.length === 1 ? selectedWires[0] : null;

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

  const onStatus = useCallback((s: EditorStatus) => {
    setStatus(s);
    // Rising edge of "dirty": the indicator says so until autosave catches up.
    setSaveState((prev) =>
      s.dirty && (prev.kind === "clean" || prev.kind === "saved") ? { kind: "dirty" } : prev,
    );
    autosaveRef.current?.notifyChanged();
  }, []);

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
      if (path.trim() === "") return; // no target (cancelled dialog) — never a "save"
      try {
        const res = await sim.save(doc, path);
        if (!res.ok) {
          toast(`Save failed: ${res.errors[0]?.message ?? "unknown error"}`);
          return;
        }
        doc.markClean();
        setFilePath(path);
        editorRef.current?.refresh(); // re-report the dirty flag
        setSaveState({ kind: "saved", at: Date.now() });
        void discardRecovery(); // the file on disk is now the truth
        diskConflictRef.current = false;
        void recordWriteStat(path);
        void takeVersion(0); // an explicit save is always its own version
        toast(`Saved ${baseName(path)}`);
      } catch (err) {
        toast(`Save failed: ${String(err)}`);
      }
    },
    [doc, sim, toast, discardRecovery, recordWriteStat, takeVersion],
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
      // The browser has no filesystem: the File System Access picker writes a
      // real file (and reports cancel); the download shim is the fallback.
      void saveTextFile(suggested, doc.toJson()).then((saved) => {
        if (!saved) return; // cancelled — nothing was written
        doc.markClean();
        setFilePath(doc.name);
        editorRef.current?.refresh();
        setSaveState({ kind: "saved", at: Date.now() });
        void discardRecovery();
        void takeVersion(0);
        toast(`Saved ${suggested}`);
      });
    }
  }, [doc, filePath, doSave, toast, discardRecovery, takeVersion]);

  const onSave = useCallback(() => {
    // Only the Tauri shell can write to a known path; outside it Save is
    // always Save-As (a download).
    if (isTauri() && filePath !== null && filePath.includes("/")) {
      void doSave(filePath);
    } else {
      onSaveAs();
    }
  }, [filePath, doSave, onSaveAs]);

  // ---- autosave: crash recovery + optional atomic file rewrite -------------

  /**
   * One flush = (1) always a crash-recovery copy while dirty, (2) for a named
   * file with file-autosave on, an atomic rewrite of the real `.csx`. Quiet on
   * success (the indicator shows it); loud on failure.
   */
  const flushAutosave = useCallback(async () => {
    const d = docRef.current;
    const path = filePathRef.current;
    // A real, writable path only exists in the Tauri shell.
    const realPath = realPathOf(path);
    setSaveState({ kind: "saving" });
    try {
      const key = await recoveryStore().write({
        path: realPath,
        docKey: docKeyRef.current,
        name: d.name,
        label: undoLabelRef.current ?? "",
        at: Date.now(),
        document: JSON.parse(d.toJson()) as unknown,
      });
      // A moved/renamed/restored document leaves its old copy behind — drop it.
      if (recoveryKeyRef.current !== null && recoveryKeyRef.current !== key) {
        void recoveryStore()
          .discard(recoveryKeyRef.current)
          .catch(() => undefined);
      }
      recoveryKeyRef.current = key;

      if (realPath !== null && autosaveFileRef.current) {
        // External-change guard: never silently overwrite a file that changed
        // underneath us (another editor, a git checkout, a dropbox sync).
        const known = lastWriteRef.current;
        if (known !== null && known.path === realPath) {
          const stat = await statFile(realPath);
          if (stat !== null && (stat.mtime_ms !== known.mtime_ms || stat.size !== known.size)) {
            if (!diskConflictRef.current) {
              diskConflictRef.current = true;
              toast(
                "That file changed on disk — autosave is paused. Save As… to keep your version, or File ▸ Reload from disk.",
              );
            }
            setSaveState({ kind: "error", message: "file changed on disk — autosave paused" });
            return;
          }
        }
        const res = await sim.save(d, realPath);
        if (!res.ok) {
          setSaveState({ kind: "error", message: res.errors[0]?.message ?? "save failed" });
          return;
        }
        d.markClean();
        editorRef.current?.refresh();
        diskConflictRef.current = false;
        await discardRecovery();
        void recordWriteStat(realPath);
        void takeVersion(VERSION_COALESCE_MS);
        setSaveState({ kind: "saved", at: Date.now() });
        return;
      }
      // Recovery-only (unnamed doc, browser, or file-autosave off).
      setSaveState({ kind: "recovered", at: Date.now() });
    } catch (err) {
      setSaveState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [sim, discardRecovery, recordWriteStat, takeVersion, toast]);

  // Keep the host's refs current (read at flush time, never at render time).
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  useEffect(() => {
    filePathRef.current = filePath;
  }, [filePath]);
  useEffect(() => {
    autosaveOnRef.current = autosaveOn;
  }, [autosaveOn]);
  useEffect(() => {
    autosaveFileRef.current = autosaveFileOn;
  }, [autosaveFileOn]);
  useEffect(() => {
    undoLabelRef.current = status?.undoLabel ?? null;
  }, [status]);

  // One controller for the app lifetime (the stress harness has no document to
  // protect). `flush` returns its promise so a close can await the write.
  if (autosaveRef.current === null && !stress) {
    autosaveRef.current = new AutosaveController({
      // Autosave off ⇒ never dirty, as far as the scheduler is concerned.
      isDirty: () => autosaveOnRef.current && docRef.current.dirty,
      revision: () => docRef.current.revision,
      flush: () => flushAutosave(),
    });
  }

  // Flush on blur — losing focus is a natural "done for now" point.
  useEffect(() => {
    const onBlur = () => void autosaveRef.current?.flush("blur");
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // Flush before the window closes: intercept, write, then really close.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow()
          .onCloseRequested(async (e) => {
            e.preventDefault();
            try {
              await autosaveRef.current?.flush("close");
            } finally {
              await getCurrentWindow().destroy();
            }
          })
          .then((u) => {
            unlisten = u;
          }),
      )
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  // Recovery on launch: offer any autosaved copies from a previous session.
  useEffect(() => {
    if (stress) return;
    void recoveryStore()
      .list()
      .then((entries) => {
        if (entries.length === 0) return;
        setRecoveries(entries);
        setRecoveryOpen(true);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on launch
  }, []);

  const restoreRecovery = useCallback(
    async (key: string) => {
      let text: string | null = null;
      try {
        text = await recoveryStore().read(key);
      } catch {
        text = null;
      }
      if (text === null) {
        toast("That autosaved copy is no longer available");
        setRecoveries((rs) => rs.filter((r) => r.key !== key));
        return;
      }
      let restored: CircuitDocument;
      try {
        restored = initDoc(CircuitDocument.fromJson(text));
      } catch (err) {
        toast(`Could not restore: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const entry = recoveries.find((r) => r.key === key);
      // It came from unsaved work, so it comes back dirty — autosave and the
      // unsaved-changes prompt must protect it again. An unnamed copy stays
      // unnamed (no path) so Save still goes through Save As…
      restored.markDirty();
      adoptDoc(restored, entry?.path ?? null);
      void sim.load(restored);
      docKeyRef.current = newDocKey();
      recoveryKeyRef.current = key; // replaced (and discarded) on the next flush
      const label = entry?.path != null ? baseName(entry.path) : restored.name;
      const left = recoveries.filter((r) => r.key !== key);
      setRecoveries(left);
      if (left.length === 0) setRecoveryOpen(false);
      toast(`Recovered ${label}`);
    },
    [recoveries, adoptDoc, sim, toast],
  );

  const discardRecoveries = useCallback(
    async (key: string | "all") => {
      const store = recoveryStore();
      const keys = key === "all" ? recoveries.map((r) => r.key) : [key];
      await Promise.all(keys.map((k) => store.discard(k).catch(() => false)));
      if (
        key === "all" ||
        (recoveryKeyRef.current !== null && keys.includes(recoveryKeyRef.current))
      ) {
        recoveryKeyRef.current = null;
      }
      const left = recoveries.filter((r) => !keys.includes(r.key));
      setRecoveries(left);
      if (left.length === 0) setRecoveryOpen(false);
    },
    [recoveries],
  );

  // ---- version history (File ▸ Version history…) ----

  /** Reload the dialog's list + usage (also used after every action). */
  const refreshHistory = useCallback(async () => {
    try {
      const [list, usage] = await Promise.all([
        historyStore().list(historyTarget()),
        historyStore().usage(),
      ]);
      setVersions(list);
      setHistoryUsage(usage);
      setHistorySelectedId((cur) =>
        cur !== null && list.some((v) => v.id === cur) ? cur : (list[0]?.id ?? null),
      );
    } catch {
      toast("Version history is unavailable");
    }
  }, [historyTarget, toast]);

  const openHistory = useCallback(async () => {
    setHistoryOpen(true);
    await refreshHistory();
  }, [refreshHistory]);

  // The preview follows the selection (read on demand — versions can be large).
  useEffect(() => {
    if (!historyOpen || historySelectedId === null) {
      setHistoryPreview(null);
      return;
    }
    let cancelled = false;
    void historyStore()
      .read(historyTarget(), historySelectedId)
      .then((text) => {
        if (!cancelled) setHistoryPreview(text);
      })
      .catch(() => {
        if (!cancelled) setHistoryPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [historyOpen, historySelectedId, historyTarget]);

  // Settings shows the footprint; refresh it whenever that dialog opens.
  useEffect(() => {
    if (!settingsOpen) return;
    void historyStore()
      .usage()
      .then(setHistoryUsage)
      .catch(() => undefined);
  }, [settingsOpen]);

  /** Restore a version: it becomes the new head; history is never rewritten. */
  const restoreVersion = useCallback(
    async (id: string) => {
      const target = historyTarget();
      const text = await historyStore()
        .read(target, id)
        .catch(() => null);
      if (text === null) {
        toast("That version is no longer available");
        void refreshHistory();
        return;
      }
      let restored: CircuitDocument;
      try {
        restored = initDoc(CircuitDocument.fromJson(text));
      } catch (err) {
        toast(`Could not restore: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const version = versions.find((v) => v.id === id);
      const label =
        version?.label !== undefined && version.label !== "" ? version.label : "version";
      try {
        await historyStore().snapshot(
          target,
          JSON.parse(text) as unknown,
          `Restored ${label}`,
          Date.now(),
          0,
        );
      } catch {
        /* best-effort */
      }
      // Comes back dirty: the snapshot is unsaved work until the next save.
      restored.markDirty();
      adoptDoc(restored, realPathOf(filePathRef.current));
      void sim.load(restored);
      setHistoryOpen(false);
      toast(`Restored ${label}`);
    },
    [historyTarget, versions, adoptDoc, sim, toast, refreshHistory],
  );

  /** Save a version to a new file (Tauri: dialog + engine write; browser: download). */
  const saveVersionCopy = useCallback(
    async (id: string) => {
      const text = await historyStore()
        .read(historyTarget(), id)
        .catch(() => null);
      if (text === null) {
        toast("That version is no longer available");
        return;
      }
      const suggested = `${docRef.current.name}-v${id}.csx`;
      if (isTauri()) {
        const path = await pickSavePath(suggested, null);
        if (path === null) return;
        try {
          const d = initDoc(CircuitDocument.fromJson(text));
          const res = await sim.save(d, path);
          if (!res.ok) {
            toast(`Save failed: ${res.errors[0]?.message ?? "unknown error"}`);
            return;
          }
          toast(`Saved ${baseName(path)}`);
        } catch (err) {
          toast(`Save failed: ${String(err)}`);
        }
      } else {
        await saveTextFile(suggested, text);
        toast(`Downloaded ${suggested}`);
      }
    },
    [historyTarget, sim, toast],
  );

  const nameVersion = useCallback(
    (id: string) => {
      const version = versions.find((v) => v.id === id);
      setNameDialog({
        title: "Name this version",
        initial: version?.label ?? "",
        submitLabel: "Name",
        onSubmit: (label) => {
          setNameDialog(null);
          void historyStore()
            .name(historyTarget(), id, label)
            .then(() => refreshHistory())
            .catch(() => undefined);
        },
      });
    },
    [versions, historyTarget, refreshHistory],
  );

  const deleteVersion = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this version? The document itself is not affected.")) return;
      await historyStore()
        .remove(historyTarget(), id)
        .catch(() => false);
      void refreshHistory();
    },
    [historyTarget, refreshHistory],
  );

  const clearHistory = useCallback(async () => {
    if (!window.confirm("Delete this file's version history? The file itself is not affected.")) {
      return;
    }
    await historyStore()
      .clear(historyTarget())
      .catch(() => false);
    await refreshHistory();
    toast("Version history cleared");
  }, [historyTarget, refreshHistory, toast]);

  /** Re-read the file from disk, discarding in-editor changes (conflict escape). */
  const reloadFromDisk = useCallback(async () => {
    const path = realPathOf(filePathRef.current);
    if (path === null) {
      toast("Reload needs a saved file — use File ▸ Open… instead");
      return;
    }
    try {
      const text = await readFileText(path);
      const reloaded = initDoc(CircuitDocument.fromJson(text));
      adoptDoc(reloaded, path);
      void sim.loadFromPath(reloaded, path);
      diskConflictRef.current = false;
      await recordWriteStat(path);
      toast(`Reloaded ${baseName(path)}`);
    } catch (err) {
      toast(`Reload failed: ${String(err)}`);
    }
  }, [adoptDoc, sim, toast, recordWriteStat]);

  // ---- sheet (subcircuit) operations (Subcircuits menu) ----

  // Live readouts from the start (UI_OVERHAUL §23): load the document into the
  // engine whenever it changes identity (mount, New, Open) so clocks, pins,
  // registers, memory and I/O show values immediately instead of type marks.
  // Edits afterwards keep the last known values until the next command.
  // NOTE: depends on the document IDENTITY only — depending on the store
  // version would re-enter while `loaded` is still false and loop.
  useEffect(() => {
    if (!sim.store.loaded) void sim.load(doc);
  }, [doc, sim]);

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

  /** Delete a circuit sheet (guarded in the document; undoable). */
  const onDeleteSheet = useCallback(
    (idx: number) => {
      const c = doc.circuit(idx);
      if (c.components.length > 0) {
        const ok = window.confirm(
          `Delete circuit "${c.name}" and its ${c.components.length} component${
            c.components.length === 1 ? "" : "s"
          }?`,
        );
        if (!ok) return;
      }
      try {
        doc.removeCircuit(idx);
      } catch (err) {
        toast(String(err instanceof Error ? err.message : err));
        return;
      }
      // Keep the active sheet pointed at a valid circuit.
      setSheet((s) => (idx < s ? s - 1 : s === idx ? Math.max(0, idx - 1) : s));
      editorRef.current?.refresh();
    },
    [doc, toast],
  );

  /** Attrs seeded when a part is placed: REQUIRED attrs plus the Editing prefs
   *  (default bit width / gate inputs) — UI_OVERHAUL §25. */
  const placementAttrs = useCallback(
    (type: string): Record<string, unknown> | undefined => {
      const seed: Record<string, unknown> = { ...(defaultAttrs(type) ?? {}) };
      if (defaultBits > 1 && editableAttrs(type).some((f) => f.key === "bitsize")) {
        seed.bitsize = defaultBits;
      }
      if (
        type.startsWith("gate.") &&
        type !== "gate.not" &&
        type !== "gate.buffer" &&
        defaultInputs > 2
      ) {
        seed.inputs = defaultInputs;
      }
      return Object.keys(seed).length === 0 ? undefined : seed;
    },
    [defaultBits, defaultInputs],
  );

  // ---- menus ----

  const menus: MenuDef[] = useMemo(() => {
    return [
      {
        label: "File",
        items: [
          { label: "New Circuit", onSelect: onNew },
          { label: "Open…", shortcut: "Ctrl+O", onSelect: () => void onOpen() },
          { kind: "sep" },
          { label: "Save", shortcut: "Ctrl+S", onSelect: onSave },
          { label: "Save As…", shortcut: "Ctrl+Shift+S", onSelect: onSaveAs },
          { label: "Reload from disk", onSelect: () => void reloadFromDisk() },
          { kind: "sep" },
          { label: "Version history…", shortcut: "Ctrl+Alt+H", onSelect: () => void openHistory() },
          { kind: "sep" },
          { label: "Settings…", onSelect: () => setSettingsOpen(true) },
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
            label: "Select All",
            shortcut: "Ctrl+A",
            onSelect: () => editorRef.current?.selectAll(),
          },
        ],
      },
      // The Simulation menu is retired for now (UI_OVERHAUL §15): the sim
      // transport bar owns step/reset/run-to, the speed slider owns the clock
      // (the Hz preset list was redundant), and the T_obs chip toggles the
      // critical-path highlight.
      // The Subcircuits menu is retired too (UI_OVERHAUL §16): a new subcircuit
      // is the tab strip's "+" and renaming is a double-click on its tab.
      {
        label: "View",
        items: [
          {
            label: "Show grid",
            checked: gridOn,
            onSelect: () => setGridOn(!gridOn),
          },
          {
            label: "Show live values",
            checked: showValues,
            onSelect: () => setShowValues(!showValues),
          },
          {
            label: "Animate signal pulses",
            checked: pulsesOn,
            onSelect: () => setPulsesOn(!pulsesOn),
          },
          {
            label: "Show performance overlay",
            checked: showPerf,
            onSelect: () => setShowPerf(!showPerf),
          },
          { kind: "sep" },
          // Duplicates the T_obs chip's click on purpose: the chip is the live
          // value, the menu item is the discoverable switch (§28).
          {
            label: "Highlight critical path",
            checked: pathOn,
            onSelect: () => setPathOn((v) => !v),
          },
        ],
      },
      {
        label: "Tools",
        items: [
          {
            label: "Recover unsaved work…",
            disabled: recoveries.length === 0,
            onSelect: () => setRecoveryOpen(true),
          },
          { label: "Clear this file's history", onSelect: () => void clearHistory() },
          { kind: "sep" },
          { label: "Settings…", onSelect: () => setSettingsOpen(true) },
          { label: "Reset appearance", onSelect: resetAppearance },
        ],
      },
      {
        label: "Help",
        items: [
          { label: "Keyboard shortcuts", shortcut: "?", onSelect: () => setShowHelp(true) },
          { label: "About CircuitSim++", onSelect: () => setShowAbout(true) },
        ],
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- simVersion invalidates the mutable store
  }, [
    doc,
    sheet,
    pathOn,
    status,
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onNewSheet,
    onRenameSheet,
    onReset,
    openHistory,
    reloadFromDisk,
    gridOn,
    showValues,
    pulsesOn,
    showPerf,
    pathOn,
    recoveries,
    clearHistory,
    resetAppearance,
    sim,
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
      if (mod && e.altKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        void openHistory();
        return;
      }
      if (e.key === "?") setShowHelp((v) => !v);
      if (e.key === "Escape") setShowHelp(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen, onSave, onSaveAs, openHistory]);

  /** The bar shows the file name; the app name lives on the logo's tooltip. */
  const docTitle = filePath === null ? "(unsaved)" : baseName(filePath);

  return (
    <div className="app" data-theme={theme} data-accent={accent}>
      <AppHeader
        logo={<AppLogoIcon />}
        title={stress ? "stress harness — ?stress=1" : docTitle}
        titleTooltip={stress ? undefined : (filePath ?? undefined)}
        status={!stress ? <SaveIndicator state={saveState} autosaveOn={autosaveOn} /> : undefined}
        menus={!stress ? <MenuBar menus={menus} /> : undefined}
        transport={
          !stress ? (
            <SimBar
              ctl={sim}
              doc={doc}
              onReset={onReset}
              pathOn={pathOn}
              onTogglePath={() => setPathOn((v) => !v)}
              hzExp={hzExp}
              onHzExp={setHzExp}
            />
          ) : undefined
        }
        actions={
          <>
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
                <button
                  className="icon-btn"
                  aria-label="Version history"
                  title="Version history (Ctrl+Alt+H)"
                  onClick={() => void openHistory()}
                >
                  <HistoryIcon />
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
          </>
        }
      />
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
                      e.stopPropagation(); // the canvas must not also act on it
                      const next =
                        paletteGroups[(i + dir + paletteGroups.length) % paletteGroups.length];
                      setPaletteGroup(next);
                      railRef.current
                        ?.querySelector<HTMLButtonElement>(`[data-group="${next}"]`)
                        ?.focus();
                    }}
                  >
                    <PaletteGroupIcon group={g} />
                    <span className="palette-rail-label">{g}</span>
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
                            onClick={(e) =>
                              editorRef.current?.startPlacing(t, e.shiftKey, placementAttrs(t))
                            }
                            onDragStart={(e) => e.dataTransfer.setData("text/x-csx-type", t)}
                            title={`${t} — click, then click the canvas to place once (Shift-click to place many; R rotates, Esc cancels)`}
                          >
                            <CompIcon type={t} />
                            <span className="palette-item-label">
                              {compSpec(t).label ?? compSpec(t).caption({})}
                            </span>
                          </button>
                        ),
                      )}
                </div>
              </div>
            </aside>
            {/* Circuit tabs live above the CANVAS column (UI_OVERHAUL §15), so
             * the side panels run the full height — no dead strip above the
             * palette (that empty band was the "gap"). */}
            <div className="editor-col">
              <SheetTabs
                sheets={doc.circuits.map((c) => c.name)}
                active={sheet}
                onSwitch={setSheet}
                onNew={onNewSheet}
                onRename={onRenameSheet}
                onDelete={onDeleteSheet}
              />
              <div className="editor-wrap">
                <EditorCanvas
                  ref={editorRef}
                  doc={doc}
                  themeName={`${theme}|${accent}`}
                  sheetIdx={sheet}
                  onStatus={onStatus}
                  onOpenSubcircuit={onOpenSubcircuit}
                  sim={sim}
                  pathIds={pathIds}
                  violations={violationMarkers}
                  pulsesOn={pulsesOn}
                  gridOn={gridOn}
                  showValues={showValues}
                  showPerf={showPerf}
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
            </div>
            <aside className="right-dock" aria-label="Details" style={{ width: panelWidths.dock }}>
              <InspectorPanel
                doc={doc}
                compId={inspectorCompId}
                selectionCount={selectedComps.length}
                circuitIdx={sheet}
                circuits={doc.circuits.filter((_, i) => i !== sheet).map((c) => c.name)}
                sheetCircuits={doc.circuits}
                wireIdx={inspectorWireIdx}
                filePath={filePath}
                onEdit={() => editorRef.current?.refresh()}
                onNotify={toast}
              />
            </aside>
          </>
        )}
      </main>
      <footer className="app-statusbar">
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
      {historyOpen && (
        <HistoryDialog
          versions={versions}
          selectedId={historySelectedId}
          preview={historyPreview}
          usage={historyUsage}
          onSelect={setHistorySelectedId}
          onRestore={(id) => void restoreVersion(id)}
          onSaveCopy={(id) => void saveVersionCopy(id)}
          onName={nameVersion}
          onDelete={(id) => void deleteVersion(id)}
          onClose={() => setHistoryOpen(false)}
        />
      )}
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
          gridOn={gridOn}
          autosaveOn={autosaveOn}
          autosaveFileOn={autosaveFileOn}
          showValues={showValues}
          showPerf={showPerf}
          defaultBits={defaultBits}
          defaultInputs={defaultInputs}
          defaultHz={hzExp}
          updateCheckOn={updateCheckOn}
          onTheme={setTheme}
          onAccent={setAccent}
          onPulses={setPulsesOn}
          onGrid={setGridOn}
          onAutosave={setAutosaveOn}
          onAutosaveFile={setAutosaveFileOn}
          onShowValues={setShowValues}
          onShowPerf={setShowPerf}
          onDefaultBits={setDefaultBits}
          onDefaultInputs={setDefaultInputs}
          onDefaultHz={setHzExp}
          onUpdateCheck={setUpdateCheckOn}
          historyUsage={historyUsage}
          onClearHistory={() => void clearHistory()}
          onReset={resetAppearance}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {recoveryOpen && recoveries.length > 0 && (
        <RecoveryDialog
          entries={recoveries}
          onRestore={(key) => void restoreRecovery(key)}
          onDiscard={(key) => void discardRecoveries(key)}
          onClose={() => setRecoveryOpen(false)}
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
                  <td>rotate selection / placement ghost (clockwise)</td>
                </tr>
                <tr>
                  <td>← ↑ → ↓</td>
                  <td>point the selection / placement ghost that way (W / N / E / S)</td>
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
