import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import StressCanvas from "./components/StressCanvas";
import CompIcon, { PaletteGroupIcon } from "./components/CompIcon";
import EditorCanvas, { type EditorHandle, type EditorStatus } from "./components/EditorCanvas";
import { MoonIcon, RedoIcon, SunIcon, UndoIcon } from "./components/icons";
import InspectorPanel from "./components/InspectorPanel";
import MenuBar, { type MenuDef } from "./components/MenuBar";
import NameDialog from "./components/NameDialog";
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
import { PALETTE, compPins, compSpec, defaultAttrs } from "./editor/catalog";
import { compLayout } from "./editor/layout";
import { buildDemoDoc } from "./editor/demoCircuit";
import { buildMockDemoDoc } from "./editor/mockDemoCircuit";
import { getCore } from "./ipc";
import { SimController } from "./sim/controller";
import { baseName, isTauri, openCircuitFile, pickSavePath, saveTextFile } from "./files";
import { DEFAULT_PANEL_WIDTHS, loadPanelWidth, savePanelWidth, type PanelId } from "./panels";
import {
  loadBoolPref,
  PREF_AUTOSAVE,
  PREF_AUTOSAVE_FILE,
  PREF_GRID,
  PREF_PULSES,
  PREF_UPDATE_CHECK,
  saveBoolPref,
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
  // Sim clock speed; lifted from SimBar so the Simulation menu shares it.
  const [hzExp, setHzExp] = useState(10); // clock speed exponent: hz = 10^(exp/10)
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
      // The browser has no filesystem: the File System Access picker writes a
      // real file (and reports cancel); the download shim is the fallback.
      void saveTextFile(suggested, doc.toJson()).then((saved) => {
        if (!saved) return; // cancelled — nothing was written
        doc.markClean();
        setFilePath(doc.name);
        editorRef.current?.refresh();
        toast(`Saved ${suggested}`);
      });
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
    const realPath = isTauri() && path !== null && path.includes("/") ? path : null;
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
        const res = await sim.save(d, realPath);
        if (!res.ok) {
          setSaveState({ kind: "error", message: res.errors[0]?.message ?? "save failed" });
          return;
        }
        d.markClean();
        editorRef.current?.refresh();
        await discardRecovery();
        setSaveState({ kind: "saved", at: Date.now() });
        return;
      }
      // Recovery-only (unnamed doc, browser, or file-autosave off).
      setSaveState({ kind: "recovered", at: Date.now() });
    } catch (err) {
      setSaveState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [sim, discardRecovery]);

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
                              editorRef.current?.startPlacing(t, e.shiftKey, defaultAttrs(t))
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
        <span>
          {doc.name}
          {status?.dirty && !autosaveOn ? " •" : ""}
        </span>
        {!stress && <SaveIndicator state={saveState} autosaveOn={autosaveOn} />}
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
          gridOn={gridOn}
          autosaveOn={autosaveOn}
          autosaveFileOn={autosaveFileOn}
          updateCheckOn={updateCheckOn}
          onTheme={setTheme}
          onAccent={setAccent}
          onPulses={setPulsesOn}
          onGrid={setGridOn}
          onAutosave={setAutosaveOn}
          onAutosaveFile={setAutosaveFileOn}
          onUpdateCheck={setUpdateCheckOn}
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
                  <td>← / →</td>
                  <td>rotate selection / placement ghost (counter-clockwise / clockwise)</td>
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
