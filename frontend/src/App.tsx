import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { PULSE_MS } from "./sim/pulses";
import AppHeader from "./components/AppHeader";
import StressCanvas from "./components/StressCanvas";
import CompIcon, { PaletteGroupIcon } from "./components/CompIcon";
import EditorCanvas, { type EditorHandle, type EditorStatus } from "./components/EditorCanvas";
import CanvasMenu, { type CanvasMenuAction } from "./components/CanvasMenu";
import type { CanvasMenuState } from "./editor/tools";
import type { LoadError, NamedComponent } from "./ipc/types";
import {
  AppLogoIcon,
  HistoryIcon,
  RedoIcon,
  SearchIcon,
  SettingsIcon,
  UndoIcon,
} from "./components/icons";
import InspectorPanel from "./components/InspectorPanel";
import MenuBar, { type MenuDef } from "./components/MenuBar";

import HistoryDrawer from "./components/HistoryDrawer";
import WaveformView from "./components/WaveformView";
import HistoryPreview from "./components/HistoryPreview";
import ClosePrompt, { type CloseChoice } from "./components/ClosePrompt";
import ConfirmDialog from "./components/ConfirmDialog";
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
import type { CsxCircuit, CsxComponent } from "./model/csx";
import { formatRadixValue, parseRadixValueMasked } from "./lib/radix";
import { saveToastText } from "./lib/saveMessage";
import { newDocKey, recoveryStore, type RecoveryMeta } from "./model/recovery";
import { historyStore, type HistoryUsage, type VersionMeta } from "./model/versionStore";
import {
  breakpointWatches,
  clockSignals,
  defaultSignals,
  namedValueBits,
  pickedSignals,
  type WaveSignal,
} from "./sim/waveform";
import { diffDocuments, highlightIds } from "./model/versionDiff";
import {
  PALETTE,
  compPins,
  compSpec,
  defaultAttrs,
  editableAttrs,
  typeDisplayName,
  type PaletteItem,
} from "./editor/catalog";
import { compLayout } from "./editor/layout";
import { buildDemoDoc } from "./editor/demoCircuit";
import { buildMockDemoDoc } from "./editor/mockDemoCircuit";
import { getCore } from "./ipc";
import { SimController } from "./sim/controller";
import {
  baseName,
  forgetSavedFileHandle,
  hasSavedFileHandle,
  isRealFilePath,
  isTauri,
  openCircuitFile,
  pickSavePath,
  saveImageFile,
  readFileText,
  renameCircuitFile,
  saveTextFile,
  siblingPath,
  statFile,
} from "./files";
import { relativeAge } from "./lib/time";
import { scopeHue } from "./lib/scope";
import { instantiators, usedByText } from "./lib/subcircuit";
import { DEFAULT_PANEL_WIDTHS, loadPanelWidth, savePanelWidth, type PanelId } from "./panels";
import {
  loadBoolPref,
  loadNumPref,
  PREF_AUTOSAVE,
  PREF_AUTOSAVE_FILE,
  PREF_DEFAULT_BITS,
  PREF_DEFAULT_HZ,
  PREF_DEFAULT_INPUTS,
  PREF_PAUSE_ON_UNKNOWN,
  PREF_GRID,
  PREF_PULSES,
  PREF_PULSE_SPEED,
  PREF_SHOW_PERF,
  PREF_SHOW_VALUES,
  PREF_TIME_24H,
  PREF_UPDATE_CHECK,
  saveBoolPref,
  saveNumPref,
} from "./prefs";
import {
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  loadAccentPref,
  loadThemePref,
  saveAccentPref,
  saveThemePref,
  type AccentId,
  type ThemeId,
} from "./theme";
import type { CompId, TimingUpdate, WireValue } from "./ipc/types";

/** Stable empty selection while no status report has arrived yet. */
const EMPTY_SELECTION: readonly string[] = [];
const EMPTY_SELECTION_NUM: readonly number[] = [];

/**
 * A real, writable file path only exists in the Tauri shell (the browser saves
 * downloads and never learns a path).
 */
function realPathOf(path: string | null): string | null {
  return isTauri() && isRealFilePath(path) ? path : null;
}

/**
 * Automatic version snapshots coalesce inside this window, so one burst of
 * editing becomes one history entry; an explicit Save always makes a new one.
 */
const VERSION_COALESCE_MS = 60_000;

/**
 * Width of the version-history drawer (UI_OVERHAUL §34). The canvas preview
 * stops where the drawer starts, so the two never overlap.
 */

/**
 * Debounce for the live re-sync on edit (UI_OVERHAUL §23): a structural edit
 * reloads the engine once edits settle, so level-triggered values appear
 * without waiting for a clock tick. Short enough to feel immediate, long
 * enough that a burst of changes (drag, multi-step edit) coalesces into one.
 */
const LIVE_RESYNC_MS = 140;

/** Fresh docs get the editor's pin knowledge so type/attr edits prune dangling wires. */
function initDoc(d: CircuitDocument): CircuitDocument {
  d.pinResolver = (comp) => compPins(comp, d.circuits).map((p) => p.name);
  // Pin geometry (position + facing): lets rotation re-anchor glued wire
  // ends and re-stub them along the new facing (wire-routing pass).
  d.pinGeometry = (comp, pin) => {
    const p = compLayout(comp, d.circuits).pins.find((x) => x.name === pin);
    return p === undefined ? null : { pos: [p.x, p.y], facing: p.facing };
  };
  // A wire end that names a pin IS at that pin. A file can name a pin whose
  // symbol has since been sized differently (hand-authored, converted, or
  // written before a constant learned to grow to its value, §56), so resolve
  // every pin end against the current layout once, here — silently, before the
  // document is adopted, so it reads as neither an edit nor unsaved work.
  d.normalizePinEnds();
  return d;
}

/**
 * App shell: VSCode-style top bar (menus + action icons) + sim transport +
 * palette + canvas + right dock (Inspector / Watch) + statusbar. The
 * circuit editor is the default view; the U1 stress harness stays reachable
 * at ?stress=1, the U4 visual showcase at ?demo=1, and the U5 mock-core
 * demo circuit at ?simdemo=1.
 */
/** Sections of the `?` shortcuts panel (UI_OVERHAUL §45). */
const HELP_SECTIONS: readonly { title: string; rows: readonly [string, string][] }[] = [
  {
    title: "Wiring",
    rows: [
      ["Click a pin", "start a wire (each click plants a bend)"],
      ["X (while wiring)", "flip the corner direction"],
      ["Drag a wire bend", "move that corner point"],
      ["Drop on a wire", "finish with a junction (dot)"],
      ["Drag from a wire", "start a wire from a junction"],
      ["Shift+click wire", "show the value on that wire"],
    ],
  },
  {
    title: "Selecting & editing",
    rows: [
      ["Click component / wire", "select (Shift toggles)"],
      ["Drag component", "move the selection (wires follow)"],
      ["↻ above a selection", "rotate it (same as R)"],
      ["Drag empty space", "box select (Ctrl/Shift adds)"],
      ["Inspector (right dock)", "edit the selection — applies live"],
      ["Right-click a subcircuit", "jump to its definition tab"],
      ["Right-click the canvas", "act on the part / wire under the pointer"],
      ["Del / Backspace", "delete the selection"],
    ],
  },
  {
    title: "Keyboard",
    rows: [
      ["R", "rotate selection / ghost (clockwise)"],
      ["← ↑ → ↓", "point the selection / ghost (W / N / E / S)"],
      ["Ctrl+C / Ctrl+X / Ctrl+V", "copy / cut / paste"],
      ["Ctrl+A", "select all"],
      ["Shift+click palette", "place many (Esc to stop)"],
      ["Esc / right-click", "cancel wiring / placement"],
      ["/", "search the palette"],
      ["?", "this panel"],
    ],
  },
  {
    title: "Files",
    rows: [
      ["Ctrl+O", "open a .csx circuit"],
      ["Ctrl+S / Ctrl+Shift+S", "save / save as"],
      ["Ctrl+Z / Ctrl+Y", "undo / redo"],
      ["Ctrl+Alt+H", "version history"],
      ["Ctrl+Alt+W", "waveform viewer"],
    ],
  },
  {
    title: "Simulation",
    rows: [
      ["Ctrl+J", "step one tick"],
      ["Ctrl+K", "run (until halt) / pause"],
      ["Ctrl+R", "reset (autoload re-applies)"],
      ["Ctrl+Alt+W", "waveform viewer (trace the run)"],
    ],
  },
  {
    title: "Pan & zoom",
    rows: [
      ["Wheel", "zoom at cursor"],
      ["Right-drag / Shift+drag", "pan (a click still cancels / selects)"],
      ["Middle-drag / Space+drag", "pan"],
      ["Panel edges", "drag to resize the palette / dock"],
    ],
  },
];

export default function App() {
  // Theme is a persisted per-machine preference (UI_OVERHAUL §2); OLED is
  // the default for fresh installs.
  const [theme, setTheme] = useState<ThemeId>(loadThemePref);
  // Appearance/behavior preferences (Settings): accent color, canvas pulse
  // animation, startup update check — per machine, all persisted.
  const [accent, setAccent] = useState<AccentId>(loadAccentPref);
  const [pulsesOn, setPulsesOn] = useState(() => loadBoolPref(PREF_PULSES, true));
  const [pulseSpeed, setPulseSpeed] = useState(() => loadNumPref(PREF_PULSE_SPEED, 100));
  const [gridOn, setGridOn] = useState(() => loadBoolPref(PREF_GRID, false));
  /** Clock timestamps: 24-hour (default) or `h:MM AM/PM` (Settings → Appearance). */
  const [time24h, setTime24h] = useState(() => loadBoolPref(PREF_TIME_24H, true));
  // Canvas readouts / overlays (Settings → Canvas).
  const [showValues, setShowValues] = useState(() => loadBoolPref(PREF_SHOW_VALUES, true));
  const [showPerf, setShowPerf] = useState(() => loadBoolPref(PREF_SHOW_PERF, false));
  // Placement seeds (Settings → Editing) and the transport's start speed.
  const [defaultBits, setDefaultBits] = useState(() => loadNumPref(PREF_DEFAULT_BITS, 1));
  const [defaultInputs, setDefaultInputs] = useState(() => loadNumPref(PREF_DEFAULT_INPUTS, 2));
  // Whether a newly placed memory part shows its clock / reset pin
  // (UI_OVERHAUL §93). Off by default: the pins are opt-in, so a fresh
  // schematic is not covered in clock/reset stubs.
  const [pauseOnUnknown, setPauseOnUnknown] = useState(() =>
    loadBoolPref(PREF_PAUSE_ON_UNKNOWN, false),
  );
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
  /** Rate-limit for the "pause the clock" hint when editing a running register. */
  const pokeHintRef = useRef(0);
  const railRef = useRef<HTMLDivElement>(null);
  /** The palette search box, so `/` can jump to it (§94). */
  const paletteSearchRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<EditorStatus | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  /** Field the Inspector should focus next (a constant's value on double-click). */
  const [inspectorFocus, setInspectorFocus] = useState<string | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Autosave (autosave, phase 1; every change since §44): a crash-recovery copy
  // written as you edit, plus — for named files, opt-out — an atomic rewrite of
  // the file. Timing lives in model/autosave.ts.
  const [autosaveOn, setAutosaveOn] = useState(() => loadBoolPref(PREF_AUTOSAVE, true));
  const [autosaveFileOn, setAutosaveFileOn] = useState(() =>
    loadBoolPref(PREF_AUTOSAVE_FILE, true),
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: "clean" });
  const [recoveries, setRecoveries] = useState<RecoveryMeta[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  /** A close request waiting on the "Save your work?" answer. */
  const [closeAsk, setCloseAsk] = useState<{
    name: string;
    resolve: (choice: CloseChoice) => void;
  } | null>(null);
  // Version history (autosave phase 3): the dialog's own little state.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [waveOpen, setWaveOpen] = useState(false);
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [historySelectedId, setHistorySelectedId] = useState<string | null>(null);
  const [historyPreview, setHistoryPreview] = useState<string | null>(null);
  const [historyUsage, setHistoryUsage] = useState<HistoryUsage | null>(null);
  // Palette activity rail (UI_OVERHAUL §8): which component group the body shows.
  const [paletteGroup, setPaletteGroup] = useState<string>(PALETTE[0].group);
  /** Palette search text (UI_OVERHAUL §94); non-empty replaces the group view with matches. */
  const [paletteQuery, setPaletteQuery] = useState("");
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
  const [toasts, setToasts] = useState<{ id: number; text: string; closing?: boolean }[]>([]);
  const [pathOn, setPathOn] = useState(false);
  // File state: real path in the Tauri shell; a bare file name after a
  // browser-mode open/download (browsers never expose real paths).
  const [filePath, setFilePath] = useState<string | null>(null);
  // Current sheet (circuit) index — subcircuits live on their own sheets.
  const [sheet, setSheet] = useState(0);
  /**
   * Instance path of the sheet being VIEWED (`""` = root, or a bare definition
   * sheet opened from a tab). Entering a subcircuit instance from the canvas
   * sets this, so the values drawn are *that instance's* — and the scope chrome
   * turns red, the same "you are inside an instance, not the class" cue the old
   * tool used. Switching sheets from the tabs clears it, because a definition
   * has no values of its own.
   */
  const [instancePath, setInstancePath] = useState("");
  const inInstance = instancePath !== "";
  const instanceLeaf = instancePath.slice(instancePath.lastIndexOf("/") + 1);
  /** Tab switch: a definition view — never an instance. */
  const switchSheet = useCallback((i: number) => {
    setSheet(i);
    setInstancePath("");
  }, []);

  /**
   * Canvas context menu (UI_OVERHAUL §75). The editor reports what a right-click
   * landed on (and makes that the selection); App renders the menu and routes the
   * pick back through the editor's public commands. Clicking away, Escape, or
   * choosing an item dismisses it — the same rules as the sheet-tab menu.
   */
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenuState | null>(null);
  const closeCanvasMenu = useCallback(() => setCanvasMenu(null), []);
  useEffect(() => {
    if (canvasMenu === null) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".canvas-menu") !== null) return;
      setCanvasMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCanvasMenu(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [canvasMenu]);
  // The state names sheet-local ids, so switching sheets closes the menu.
  useEffect(() => closeCanvasMenu(), [sheet, closeCanvasMenu]);

  /** The newest `showInWaveform` (declared further down), for the context menu. */
  const showInWaveformRef = useRef<() => void>(() => {});
  /** Run one context-menu item through the editor's public commands (§75). */
  const onCanvasMenuAction = useCallback((action: CanvasMenuAction) => {
    const ed = editorRef.current;
    if (ed === null) return;
    if (action === "cut") ed.cut();
    else if (action === "copy") ed.copy();
    else if (action === "paste") ed.paste();
    else if (action === "delete") ed.deleteSelection();
    else if (action === "rotate-cw") ed.rotate(false);
    else if (action === "rotate-ccw") ed.rotate(true);
    else if (action === "waveform") void showInWaveformRef.current();
    else ed.selectAll();
  }, []);

  // ---- autosave plumbing (the scheduler itself is created further down) ----
  // Refs mirror the mutable state its host reads at flush time, so the
  // controller never closes over a stale document or path.
  const autosaveRef = useRef<AutosaveController | null>(null);
  const docRef = useRef(doc);
  const filePathRef = useRef(filePath);
  const autosaveOnRef = useRef(autosaveOn);
  /** The close guard, for the once-registered window close handler. */
  const guardCloseRef = useRef<(() => Promise<boolean>) | null>(null);
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
  /**
   * Circuits whose TAB is closed (§99), by name. Closing a tab never deletes the
   * circuit: it stays in the file and in the Circuits explorer, which reopens it.
   * View state for this session, like the active sheet — not saved in the file.
   */
  const [closedSheets, setClosedSheets] = useState<ReadonlySet<string>>(() => new Set());
  /** A destructive action waiting on "are you sure?" (§99). */
  const [confirmAsk, setConfirmAsk] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  /** Sheet index being renamed inline in its tab, or null (UI_OVERHAUL §60). */
  const [renamingSheet, setRenamingSheet] = useState<number | null>(null);
  /** The sheet that just appeared — drives its slide-in animation (§60). */
  const [enteringSheet, setEnteringSheet] = useState<number | null>(null);
  const simVersion = useSyncExternalStore(sim.store.subscribe, () => sim.store.getVersion());

  // Current sheet name (safe while a doc/sheet swap is mid-render).
  const sheetName = doc.circuits[sheet]?.name;
  // §77: the active sheet's SCOPE. The top level has none; a subcircuit sheet gets
  // a hue of its own (stable per name) for the tab, the canvas frame and the
  // status chip, so "which scope am I in" is never a guess.
  const scope = sheet > 0 && sheetName !== undefined ? scopeHue(sheetName) : null;
  // §80: where this sheet is used, and the way back. The parent is DERIVED from the
  // document — the sheets that instantiate this circuit — rather than a navigation
  // history that goes stale the moment someone switches sheets by tab.
  const scopeParents =
    scope !== null && sheetName !== undefined ? instantiators(doc.circuits, sheetName) : [];
  const scopeParentName = scopeParents[0] ?? doc.circuits[0]?.name;

  // Palette rail groups (UI_OVERHAUL §8): Subcircuits only exists while the
  // document has more than one circuit; if the active group disappears the
  // body falls back to the first group. Computed inline — the document is
  // mutated in place, so there is no identity to memoize on.
  // The rail always carries a Subcircuits group (UI_OVERHAUL §80): a feature you
  // only find after making your first subcircuit is one most people never find, so
  // the group has an empty state and its own "New subcircuit" button. The circuit
  // *hierarchy* lives in the right dock's empty state (CircuitTree), not a second
  // rail group — a definition list and its explorer were two answers to one thing.
  const paletteGroups = [...PALETTE.map((g) => g.group), "Subcircuits"];
  const activePaletteGroup = paletteGroups.includes(paletteGroup) ? paletteGroup : PALETTE[0].group;

  // Preference persistence (best-effort; non-fatal without storage).
  useEffect(() => {
    saveThemePref(theme);
    // Mirror onto <html> too (index.html sets it before first paint), so the
    // page background and native widgets follow a theme picked in Settings.
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    saveAccentPref(accent);
  }, [accent]);
  useEffect(() => {
    saveBoolPref(PREF_PULSES, pulsesOn);
    saveNumPref(PREF_PULSE_SPEED, pulseSpeed);
  }, [pulsesOn]);
  useEffect(() => {
    saveBoolPref(PREF_GRID, gridOn);
  }, [gridOn]);
  useEffect(() => {
    saveBoolPref(PREF_TIME_24H, time24h);
  }, [time24h]);
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
    saveBoolPref(PREF_PAUSE_ON_UNKNOWN, pauseOnUnknown);
    // A load or reset rebuilds the engine, so the *adapter* re-sends this after one
    // (`ipc/tauri.ts`'s `reapplyPrefs`); here it just has to reach the engine now.
    void getCore().api.setPauseOnUnknown(pauseOnUnknown);
  }, [pauseOnUnknown]);
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

  /**
   * A named part's declared width, from the document.  `comp_id` is
   * document-order within its own circuit (contract v1.2), so this is a lookup,
   * not a search.
   */
  const bitsOfNamed = useCallback(
    (n: NamedComponent): number | undefined => {
      const circuit = doc.circuits.find((c) => c.name === n.circuit);
      const comp = circuit?.components[n.comp_id];
      return comp === undefined ? undefined : namedValueBits(comp, n.kind, doc.circuits);
    },
    [doc],
  );

  /** A pin's declared width, from the registry's per-type pin specs. */
  const bitsOfPin = useCallback(
    (compId: string, pin: string): number | undefined => {
      const comp = doc.circuits[sheet]?.components.find((c) => c.id === compId);
      if (comp === undefined) return undefined;
      const spec = compPins(comp, doc.circuits).find((p) => p.name === pin);
      return spec === undefined ? undefined : (spec.bitsize ?? 1);
    },
    [doc, sheet],
  );

  /**
   * Signals the current canvas selection would add to the trace (UI_OVERHAUL
   * §89).  A selected wire is itself; a selected part contributes its OUTPUT
   * pin's net (a gate's `out`, a register's `q`) — the value you would probe.
   * Resolved here rather than in the viewer because picking that pin needs the
   * registry's per-type pin specs.
   */
  const pickSelection = useCallback((): WaveSignal[] => {
    const circuit = doc.circuits[sheet];
    const wireToNet = sim.store.wireToNet;
    if (circuit === undefined || wireToNet === null) return [];
    const selectedPins: { comp: string; pin: string }[] = [];
    for (const id of selectedComps) {
      const comp = circuit.components.find((c) => c.id === id);
      if (comp === undefined) continue;
      // The value you would probe: the OUTPUT. A part with none (a probe, an
      // LED) is traced by the value it reads, its first pin.
      const pins = compPins(comp, doc.circuits);
      const pin = pins.find((p) => p.kind === "out") ?? pins[0];
      if (pin !== undefined) selectedPins.push({ comp: id, pin: pin.name });
    }
    // Human labels (§96): the part's name — or its plain type — and the pin,
    // instead of the internal id (`c3.out` → `Adder.out`); a named wire is its name.
    return pickedSignals({
      wires: circuit.wires,
      wireToNet,
      selectedWires,
      selectedPins,
      bitsOf: bitsOfPin,
    }).map((sig) => {
      const pinPick = /^p:(.+)\.([^.]+)$/.exec(sig.key);
      if (pinPick !== null) {
        const comp = circuit.components.find((c) => c.id === pinPick[1]);
        if (comp === undefined) return sig;
        const base =
          comp.name !== undefined && comp.name !== "" ? comp.name : typeDisplayName(comp.type);
        return { ...sig, label: `${base}.${pinPick[2]}` };
      }
      const wirePick = /^w:(\d+)$/.exec(sig.key);
      const name = wirePick === null ? undefined : circuit.wires[Number(wirePick[1])]?.name;
      return name !== undefined && name !== "" ? { ...sig, label: name } : sig;
    });
  }, [doc, sheet, selectedComps, selectedWires, sim, bitsOfPin]);
  // simVersion keeps the net map fresh across a reload.
  const wavePicked = useMemo<WaveSignal[]>(
    () => (waveOpen ? pickSelection() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- simVersion invalidates the mutable store
    [waveOpen, pickSelection, simVersion],
  );
  /**
   * Signals to add to the trace on the next render (§96): "Show in waveform"
   * opens the viewer WITH the selection in it. `seq` makes a repeat request for
   * the same signals still count.
   */
  const [waveAdd, setWaveAdd] = useState<{ signals: WaveSignal[]; seq: number } | null>(null);

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

  // §74: the same path's *observed* settle time, offered only for a selected part
  // that is on it — a path's delay is not a property of an arbitrary part.
  const criticalPathNs =
    pathIds !== null && inspectorCompId !== null && pathIds.includes(inspectorCompId)
      ? sim.topPathDelay(sheetName)
      : null;

  // A fresh load invalidates any path highlight.
  useEffect(() => {
    if (!sim.store.loaded && pathOn) setPathOn(false);
  }, [sim.store, pathOn, simVersion]);

  const toast = useCallback((text: string) => {
    setToasts((t) => [...t, { id: Date.now() + Math.random(), text }]);
  }, []);

  /** What a fresh trace opens with: the named parts, plus every clock (§89). */
  const waveDefaults = useMemo<WaveSignal[]>(() => {
    const circuit = doc.circuits[sheet];
    const wireToNet = sim.store.wireToNet;
    const named = defaultSignals(sim.store.named, bitsOfNamed);
    if (circuit === undefined || wireToNet === null) return named;
    return [
      ...named,
      ...clockSignals({ wires: circuit.wires, wireToNet, components: circuit.components }),
    ];
    // simVersion keeps the net map fresh across a reload.
  }, [doc, sheet, sim.store.named, sim.store.wireToNet, simVersion, bitsOfNamed]);

  /**
   * Breakpoints on the sheet being traced (§90): each watched net and the
   * condition it stops on.  Resolved document-level, like every other signal the
   * viewer shows, so the trace marks what the schematic says rather than what
   * the engine happens to name.
   */
  const waveWatches = useMemo<ReadonlyMap<number, readonly string[]>>(() => {
    const circuit = doc.circuits[sheet];
    const wireToNet = sim.store.wireToNet;
    if (circuit === undefined || wireToNet === null) return new Map();
    return breakpointWatches({
      wires: circuit.wires,
      wireToNet,
      components: circuit.components,
    });
    // simVersion keeps the net map fresh across a reload.
  }, [doc, sheet, sim.store.wireToNet, simVersion]);

  /**
   * Open the waveform viewer (§96). It used to refuse until the sim had run
   * ("load a circuit and run the sim first"), which hid the feature exactly
   * when someone went looking for it: now it loads the circuit itself and opens
   * on an empty trace that says to press Tick or Play.
   *
   * The viewer is shown **immediately** and the circuit is synced in the
   * background (the viewer subscribes to the store, so its default rows appear
   * as soon as the load lands). Syncing first and only then flipping the state
   * made the button feel dead for the length of a load, and — worse — a second
   * press started a *second* open whose late resolution re-opened the viewer
   * after the user had already closed it. That is the "stuck in the waveform"
   * report: the toggle must be synchronous.
   */
  const openWaveform = useCallback(() => {
    setHistoryOpen(false);
    // A fresh view: don't inherit the signals from an earlier "Show in
    // waveform" (the viewer unmounts on close, but `waveAdd` outlives it).
    setWaveAdd(null);
    setWaveOpen(true);
    void sim.resync(doc).then((ok) => {
      if (!ok) toast("The circuit does not load yet — the banner has the details");
    });
  }, [sim, doc, toast]);

  /** Open the viewer with the current selection added to it (context menu / Inspector). */
  const showInWaveform = useCallback(() => {
    // Show the viewer at once; the picked signal is added once the circuit is
    // synced (the viewer consumes `waveAdd` whenever it arrives). Drop any
    // previous pick first, so reopening never replays stale signals.
    setHistoryOpen(false);
    setWaveAdd(null);
    setWaveOpen(true);
    void sim.resync(doc).then((ok) => {
      if (!ok) {
        toast("The circuit does not load yet — the banner has the details");
        return;
      }
      const signals = pickSelection();
      if (signals.length === 0) {
        toast("Nothing to trace there — select a wire, or a part with an output");
        return;
      }
      setWaveAdd((prev) => ({ signals, seq: (prev?.seq ?? 0) + 1 }));
    });
  }, [sim, doc, pickSelection, toast]);
  showInWaveformRef.current = showInWaveform;
  /** Click a toast to dismiss: bulge briefly, then remove it. */
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, closing: true } : t)));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 160);
  }, []);
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => setToasts((t) => t.slice(1)), 2600);
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
      if (!sim.store.loaded || sim.isStale(doc)) {
        const ok = await sim.resync(doc);
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

  // Poke a component pin to a live value (a register's typed value, §61): the
  // engine's CompId is the sheet's document-order index.
  const onPoke = useCallback(
    (compId: string, pin: string, hex: string) => {
      const idx = doc.circuit(sheet).components.findIndex((c) => c.id === compId);
      if (idx < 0) return;
      // Show the poked value on the register immediately: the engine's readout
      // is delay-gated (and absent when q is unwired), so the canvas would
      // otherwise keep showing the old value until the next tick.
      sim.rememberPokedRegister(compId, hex);
      void (async () => {
        if (!(await sim.resync(doc))) return;
        await sim.poke(idx, pin, { v: hex, x: "", z: "" });
      })();
    },
    [doc, sheet, sim],
  );

  /**
   * Apply one inline-register edit step: parse `text` in the register's base and
   * poke it immediately (no Enter). A value that would not fit is rejected with
   * a toast, and the caller keeps the previous text.
   */
  const applyRegInput = useCallback(
    (comp: CsxComponent, text: string) => {
      const radix = typeof comp.attrs?.radix === "string" ? comp.attrs.radix : "hex";
      const parse = radix === "bin" ? "bin" : radix === "hex" ? "hex" : "dec";
      const bits = compPins(comp, doc.circuits).find((p) => p.name === "q")?.bitsize ?? 1;
      // Mask rather than reject overflow: extra digits are dropped at the
      // most-significant end (fixed-width shift), so you can keep typing.
      const hex = parseRadixValueMasked(text, parse, bits);
      if (hex === null) {
        toast(`Enter a ${radix} number`);
        return;
      }
      // Keep the edit buffer as the *resulting* value in the register's base, so
      // the next keystroke appends to what is actually stored.
      sim.setRegisterEdit(comp.id, formatRadixValue(hex, radix, bits));
      onPoke(comp.id, "q", hex);
    },
    [doc, onPoke, sim, toast],
  );

  const onStatus = useCallback((s: EditorStatus) => {
    setStatus(s);
    // Rising edge of "dirty": the indicator says so until autosave catches up.
    setSaveState((prev) =>
      s.dirty && (prev.kind === "clean" || prev.kind === "saved") ? { kind: "dirty" } : prev,
    );
    autosaveRef.current?.notifyChanged();
  }, []);

  // ---- file operations (File menu) ----

  /**
   * Set the document's path in React state AND in `filePathRef`, in the same
   * tick. Async work reads the ref (version-history/recovery keying, the
   * external-change guard), and `setFilePath` alone leaves it stale until the
   * next render — so the version an explicit save took was keyed to the
   * *pre-save* document, and a freshly saved file's history looked empty.
   */
  const setFilePathNow = useCallback((path: string | null) => {
    filePathRef.current = path;
    setFilePath(path);
  }, []);

  /** Replace the editor document (New/Open); the sim engine is re-synced by the caller. */
  const adoptDoc = useCallback(
    (d: CircuitDocument, path: string | null) => {
      setDoc(d);
      setFilePathNow(path);
      setSheet(0);
      setClosedSheets(new Set()); // a new file opens with every tab
    },
    [setFilePathNow],
  );

  const confirmDiscard = useCallback(() => {
    if (!doc.dirty) return true;
    return window.confirm(`Discard unsaved changes to ${filePath ?? doc.name}?`);
  }, [doc, filePath]);

  const onNew = useCallback(() => {
    if (!confirmDiscard()) return;
    sim.unload();
    adoptDoc(initDoc(CircuitDocument.create("untitled")), null);
    // A fresh document is a fresh session: without a new key it would inherit
    // the previous unnamed document's recovery copy and version history.
    docKeyRef.current = newDocKey();
    forgetSavedFileHandle(); // a new document must not overwrite the last file (§38)
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
    // A different file is a different session: reset the key so an opened
    // (path-less) document does not share the previous document's history or
    // recovery. Path-backed documents key by path anyway.
    docKeyRef.current = newDocKey();
    forgetSavedFileHandle(); // opened a different file (§38)
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
        setFilePathNow(path);
        editorRef.current?.refresh(); // re-report the dirty flag
        setSaveState({ kind: "saved", at: Date.now() });
        await discardRecovery(); // the file on disk is now the truth
        diskConflictRef.current = false;
        void recordWriteStat(path);
        void takeVersion(0); // an explicit save is always its own version
        // The engine writes even when the document fails validation — losing a
        // draft is worse than saving one — and reports the problems as
        // warnings, so this says "saved" and names them (the previous clean
        // state is still in Version history).
        toast(saveToastText(baseName(path), res.errors.length));
      } catch (err) {
        toast(`Save failed: ${String(err)}`);
      }
    },
    [doc, sim, toast, discardRecovery, recordWriteStat, takeVersion, setFilePathNow],
  );

  /**
   * Browser save (§38): with a file already chosen this writes straight to it,
   * so Ctrl+S behaves like a real save instead of re-asking for a name. Only
   * "Save As" (or the first save) opens the picker.
   */
  const saveInBrowser = useCallback(
    async (suggested: string, forcePicker: boolean): Promise<boolean> => {
      const saved = await saveTextFile(suggested, doc.toJson(), { forcePicker });
      if (!saved) return false; // cancelled — nothing was written
      doc.markClean();
      setFilePathNow(doc.name);
      editorRef.current?.refresh();
      setSaveState({ kind: "saved", at: Date.now() });
      await discardRecovery();
      void takeVersion(0);
      toast(`Saved ${suggested}`);
      return true;
    },
    [doc, discardRecovery, takeVersion, toast, setFilePathNow],
  );

  /**
   * The one save entry point. The Tauri shell writes to the known path; the
   * browser writes to the file it already has a handle for. Either way only the
   * FIRST save (or `forcePicker`) asks where. Resolves true when bytes were
   * written — a cancelled dialog and a failed write both resolve false, which is
   * what the close guard needs to know before letting the window go.
   */
  const saveNow = useCallback(
    async (forcePicker: boolean): Promise<boolean> => {
      const suggested = `${doc.name}.csx`;
      try {
        if (!isTauri()) {
          return await saveInBrowser(suggested, forcePicker || !hasSavedFileHandle());
        }
        const known = filePathRef.current;
        let path = known;
        if (forcePicker || !isRealFilePath(known)) {
          path = await pickSavePath(suggested, isRealFilePath(known) ? known : null);
          if (path === null) return false; // cancelled
        }
        if (path === null) return false;
        await doSave(path);
        return !docRef.current.dirty; // `doSave` marks clean only on success
      } catch (err) {
        toast(`Save failed: ${String(err)}`);
        return false;
      }
    },
    [doc, doSave, saveInBrowser, toast],
  );

  const onSaveAs = useCallback(() => {
    void saveNow(true);
  }, [saveNow]);

  const onSave = useCallback(() => {
    void saveNow(false);
  }, [saveNow]);

  /**
   * Export what the canvas is showing (UI_OVERHAUL §66). The renderer owns the
   * pixels, so the canvas element is asked for a PNG and the file plumbing
   * delivers it — a real file in the shell, a download in the browser. The name
   * gets a `-view` suffix so it can sit beside the `.csx` it came from.
   */
  const exportCanvasPng = useCallback(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.circuit-canvas");
    if (canvas === null) return;
    try {
      const ok = await saveImageFile(`${doc.name}-view`, canvas.toDataURL("image/png"));
      if (ok) toast(`Exported ${doc.name}-view.png`);
    } catch (err) {
      toast(`Export failed: ${String(err)}`);
    }
  }, [doc, toast]);

  /**
   * The close guard (2026-10-19). A *clean* close must never need recovery after
   * the fact, so an unsaved document is resolved before the window goes: Save
   * (a Save As when it has never been named), Don't save, or Cancel. Resolves
   * true when the window may close.
   */
  const guardClose = useCallback(async (): Promise<boolean> => {
    if (!docRef.current.dirty) return true; // nothing at risk
    const choice = await new Promise<CloseChoice>((resolve) =>
      setCloseAsk({ name: docRef.current.name, resolve }),
    );
    setCloseAsk(null);
    if (choice === "cancel") return false;
    // A save that was cancelled or failed leaves the document dirty: stay, and
    // keep the recovery copy — the work is still at risk.
    if (choice === "save" && !(await saveNow(false))) return false;
    // Any resolved decision ends the recovery copy's purpose: it exists for
    // sessions that ended without one (a crash).
    await discardRecovery();
    return true;
  }, [saveNow, discardRecovery]);

  /** What the inline title editor starts from (no `.csx`, no path). */
  const renameValue = useMemo(
    () => (filePath === null ? doc.name : baseName(filePath)).replace(/\.csx$/i, ""),
    [doc, filePath],
  );

  /**
   * Commit the inline title edit (§39). In the shell a file that already exists
   * is renamed in place — its version history moves with it — and the new name
   * is written into the document. A document with no file yet (or the browser,
   * which cannot rename) names itself through a save instead.
   */
  const renameFile = useCallback(
    (name: string) => {
      const clean = name.trim();
      if (clean === "") return;
      doc.rename(clean);
      editorRef.current?.refresh();
      const realPath = realPathOf(filePathRef.current);
      if (isTauri()) {
        if (realPath === null) {
          void pickSavePath(`${clean}.csx`, null)
            .then((path) => {
              if (path !== null) void doSave(path);
            })
            .catch((err) => toast(`Save failed: ${String(err)}`));
          return;
        }
        void renameCircuitFile(realPath, siblingPath(realPath, `${clean}.csx`))
          .then((next) => {
            setFilePathNow(next);
            diskConflictRef.current = false;
            void recordWriteStat(next);
            void doSave(next); // the file's own `name` field follows
            return next;
          })
          .then((next) => toast(`Renamed to ${baseName(next)}`))
          .catch((err) => toast(`Rename failed: ${String(err)}`));
        return;
      }
      // A browser cannot rename a file, so the new name is written into the
      // file it already holds a handle for; only a first save asks where.
      void saveInBrowser(`${clean}.csx`, false).catch((err) =>
        toast(`Save failed: ${String(err)}`),
      );
    },
    [doc, doSave, recordWriteStat, saveInBrowser, toast, setFilePathNow],
  );

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
    guardCloseRef.current = guardClose;
  }, [guardClose]);
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
            // Ask before closing rather than offering recovery afterwards: a
            // clean close leaves nothing to recover.
            if ((await guardCloseRef.current?.()) !== true) return;
            await getCurrentWindow().destroy();
          })
          .then((u) => {
            unlisten = u;
          }),
      )
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  // The browser (dev fallback) has no close request to intercept, so its own
  // warning is the guard: it fires only while the document is dirty, and the
  // recovery copy stays behind it (a reload is as likely as a close there).
  useEffect(() => {
    if (isTauri()) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!docRef.current.dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Recovery on launch: a copy is left behind only when the last session ended
  // without closing (a crash) — a clean close discards it, because by then the
  // person has decided.
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
      const text = await recoveryStore()
        .read(key)
        .catch(() => null);
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
    // The two full views are exclusive: history over a hidden canvas is fine,
    // history *behind* a waveform is not a state anyone wants to return to.
    setWaveOpen(false);
    setHistoryOpen(true);
    await refreshHistory();
  }, [refreshHistory]);

  /** Close the drawer and drop the preview (the canvas returns to the live doc). */
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setHistorySelectedId(null);
  }, []);

  /** The version the drawer has selected. */
  const selectedVersion = useMemo(
    () => versions.find((v) => v.id === historySelectedId) ?? null,
    [versions, historySelectedId],
  );

  /** "5 min ago · Added the ALU" for the preview banner. */
  const previewLabel = useMemo(() => {
    if (selectedVersion === null) return "an older version";
    const when = relativeAge(selectedVersion.at_ms);
    return selectedVersion.label !== "" ? `${when} · ${selectedVersion.label}` : when;
  }, [selectedVersion]);

  /** How the previewed version differs from the open document (§38). */
  const versionDiff = useMemo(() => {
    if (!historyOpen || historyPreview === null) return null;
    try {
      return diffDocuments(doc, CircuitDocument.fromJson(historyPreview));
    } catch {
      return null;
    }
  }, [historyOpen, historyPreview, doc]);

  // §76: the parts this version adds or changes — the preview outlines them on
  // the canvas. Removals show only in the list (the part is not in the version).
  const diffHighlight = useMemo(
    () => (versionDiff === null ? [] : highlightIds(versionDiff)),
    [versionDiff],
  );

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
      setHistorySelectedId(null);
      toast(`Restored ${label}`);
    },
    [historyTarget, versions, adoptDoc, sim, toast, refreshHistory],
  );

  /** Save a version to a new file (Tauri: dialog + engine write; browser: download). */
  /** Rename a version in place (the drawer's click-the-name edit, §38). */
  const renameVersion = useCallback(
    (id: string, label: string) => {
      void historyStore()
        .name(historyTarget(), id, label)
        .then(() => refreshHistory())
        .catch(() => undefined);
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
    // Reload READS the file over the in-memory document, so it discards edits
    // exactly like Open does — ask first (the tester found this surprising).
    if (!confirmDiscard()) return;
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
  }, [confirmDiscard, adoptDoc, sim, toast, recordWriteStat]);

  // ---- sheet (subcircuit) operations (Subcircuits menu) ----

  // Live readouts from the start (UI_OVERHAUL §23): load the document into the
  // engine whenever it changes identity (mount, New, Open) so clocks, pins,
  // registers, memory and I/O show values immediately instead of type marks.
  // NOTE: depends on the document IDENTITY only — depending on the store
  // version would re-enter while `loaded` is still false and loop.
  useEffect(() => {
    if (!sim.store.loaded) void sim.load(doc);
  }, [doc, sim]);

  // Live re-sync on edit (UI_OVERHAUL §23): a structural change — placed part,
  // new wire, attribute edit — reloads the document once edits settle, so
  // level-triggered values (a constant driving a net, a gate's output) appear
  // on the canvas immediately instead of waiting for the next clock tick. The
  // reload re-settles the whole circuit (fresh power-on: clocked state clears,
  // as on any topology change), so it is skipped while the sim is running — a
  // run keeps its state until the next command, which re-syncs on its own.
  // `revision` bumps only on real mutations, not on selection/tool changes.
  const docRevision = status?.revision;
  useEffect(() => {
    if (docRevision === undefined) return;
    // Stale while loaded, or a failed load whose problem may now be fixed (§99).
    const due = sim.store.loaded ? sim.isStale(doc) : sim.needsRetry(doc);
    if (!due) return;
    if (sim.store.status?.running ?? false) return;
    const timer = setTimeout(() => void sim.resync(doc), LIVE_RESYNC_MS);
    return () => clearTimeout(timer);
  }, [docRevision, doc, sim]);

  /**
   * Open a subcircuit instance. With a `compId` this ENTERS the instance
   * (extending the instance path), so the sheet shows that instance's values
   * with the red chrome; without one it just opens the definition tab (a
   * class view). This mirrors CE: you drill into a specific instance, not the
   * definition, to watch it run.
   */
  const onOpenSubcircuit = useCallback(
    (circuit: string, compId?: string) => {
      const idx = doc.circuitIdxByName(circuit);
      if (idx < 0) {
        toast(`Subcircuit "${circuit}" is not in this file`);
        return;
      }
      setSheet(idx);
      // The INSTANCE view (red chrome, "these are its values") only means
      // something once there are values: a run has happened. Before that a
      // double-click is someone going in to edit the definition, and painting
      // that red read as an error at the wrong time (§98).
      const ran = sim.store.status !== null || sim.store.cycle > 0;
      if (compId !== undefined && ran) {
        setInstancePath((p) => (p === "" ? compId : `${p}/${compId}`));
      } else {
        setInstancePath("");
      }
    },
    [doc, toast, sim],
  );

  /** Step back out of the current instance (to its parent sheet). */
  const exitInstance = useCallback(() => {
    setInstancePath((p) => {
      const i = p.lastIndexOf("/");
      return i < 0 ? "" : p.slice(0, i);
    });
    const parent = doc.circuitIdxByName(scopeParentName ?? "");
    if (parent >= 0) setSheet(parent);
  }, [doc, scopeParentName]);

  /**
   * New subcircuit (UI_OVERHAUL §60): the tab is created immediately with a
   * default name and slides in, then its label becomes an inline input — type
   * the name right in the tab. No popup.
   */
  const onNewSheet = useCallback(() => {
    const taken = new Set(doc.circuits.map((c) => c.name));
    let n = doc.circuits.length;
    while (taken.has(`sub${n}`)) n++;
    try {
      const idx = doc.addCircuit(`sub${n}`);
      setSheet(idx);
      // A brand-new definition is never an instance view: without this, making
      // a subcircuit from inside an instance kept the red instance chrome (§98).
      setInstancePath("");
      setEnteringSheet(idx);
      setRenamingSheet(idx);
      editorRef.current?.refresh();
      // Drop the slide-in class once the animation has played.
      window.setTimeout(() => setEnteringSheet((cur) => (cur === idx ? null : cur)), 400);
    } catch (err) {
      toast(String(err instanceof Error ? err.message : err));
    }
  }, [doc, toast]);

  /** Double-click (or the middle-click menu's Rename) edits the label in place. */
  const onRenameSheet = useCallback((idx: number) => {
    setRenamingSheet(idx);
  }, []);

  const onCommitSheetName = useCallback(
    (idx: number, name: string) => {
      setRenamingSheet(null);
      try {
        doc.renameCircuit(idx, name);
        editorRef.current?.refresh();
      } catch (err) {
        toast(String(err instanceof Error ? err.message : err));
      }
    },
    [doc, toast],
  );

  const onCancelSheetName = useCallback(() => setRenamingSheet(null), []);

  /** Delete a circuit sheet (guarded in the document; undoable). */
  const deleteSheetNow = useCallback(
    (idx: number) => {
      const c = doc.circuit(idx);
      try {
        doc.removeCircuit(idx);
      } catch (err) {
        toast(String(err instanceof Error ? err.message : err));
        return;
      }
      setClosedSheets((prev) => {
        if (!prev.has(c.name)) return prev;
        const next = new Set(prev);
        next.delete(c.name);
        return next;
      });
      // Keep the active sheet pointed at a valid circuit.
      setSheet((s) => (idx < s ? s - 1 : s === idx ? Math.max(0, idx - 1) : s));
      editorRef.current?.refresh();
    },
    [doc, toast],
  );

  /** Delete a circuit — always asked first, in the app's own dialog (§99). */
  const onDeleteSheet = useCallback(
    (idx: number) => {
      const c = doc.circuit(idx);
      const n = c.components.length;
      setConfirmAsk({
        title: `Delete "${c.name}"?`,
        body:
          (n > 0
            ? `The circuit and its ${n} part${n === 1 ? "" : "s"} are removed from the file. `
            : "The empty circuit is removed from the file. ") +
          "Undo (Ctrl+Z) brings it back. To just hide it, close its tab instead.",
        confirmLabel: "Delete",
        onConfirm: () => deleteSheetNow(idx),
      });
    },
    [doc, deleteSheetNow],
  );

  /**
   * Close a tab (§99): the circuit stays in the file. The last open tab cannot
   * close — the canvas always shows a circuit.
   */
  const onCloseSheet = useCallback(
    (idx: number) => {
      const name = doc.circuit(idx).name;
      const open = doc.circuits
        .map((c, j) => ({ c, j }))
        .filter(({ c, j }) => j !== idx && !closedSheets.has(c.name))
        .map(({ j }) => j);
      if (open.length === 0) return;
      setClosedSheets((prev) => new Set(prev).add(name));
      if (idx === sheet) {
        // The neighbour to the left, as an editor does; else the first open one.
        const left = open.filter((j) => j < idx);
        switchSheet(left.length > 0 ? left[left.length - 1] : open[0]);
      }
    },
    [doc, closedSheets, sheet, switchSheet],
  );

  /**
   * The load-error banner's Fix (§100): open the sheet the error is on (even a
   * closed tab), select the part it names, and — for a name problem — put the
   * cursor in its Name field. The id comes from the error's `comp_id` when the
   * engine sent one, else from the `component '<id>'` its message carries.
   */
  const locateLoadError = useCallback(
    (err: LoadError) => {
      const ci = err.circuit === "" ? 0 : doc.circuitIdxByName(err.circuit);
      if (ci < 0) return;
      const c = doc.circuit(ci);
      const fromMsg = /component '([^']+)'/.exec(err.message)?.[1];
      const id = fromMsg ?? (err.comp_id !== undefined ? c.components[err.comp_id]?.id : undefined);
      setHistoryOpen(false);
      setWaveOpen(false);
      switchSheet(ci);
      if (id === undefined || !c.components.some((x) => x.id === id)) return;
      // After the sheet switch has rendered (it clears the selection).
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          editorRef.current?.select([id]);
          if (/named|name/i.test(err.message)) setInspectorFocus("name");
        }),
      );
    },
    [doc, switchSheet],
  );

  // Whatever brings a closed circuit to the canvas — the hierarchy tree, the
  // tab strip, a double-click into an instance, the scope bar's way back —
  // reopens its tab.
  useEffect(() => {
    const name = doc.circuits[sheet]?.name;
    if (name === undefined || !closedSheets.has(name)) return;
    setClosedSheets((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, [sheet, doc, closedSheets]);

  const hiddenSheets = useMemo(
    () =>
      new Set(
        doc.circuits.flatMap((c, i) => (closedSheets.has(c.name) ? [i] : [])),
      ) as ReadonlySet<number>,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- docRevision tracks in-place renames
    [doc, closedSheets, status?.revision],
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
      // Clock and reset are not seeded: the pins are always in the model, the editor always
      // draws them, and placement wires them (`editor/clockDefaults.ts`).
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
          { label: "Export view as PNG…", onSelect: () => void exportCanvasPng() },
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
            label: "Cut",
            shortcut: "Ctrl+X",
            disabled: (status?.selection ?? 0) === 0,
            onSelect: () => editorRef.current?.cut(),
          },
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
            label: "Waveform viewer",
            shortcut: "Ctrl+Alt+W",
            checked: waveOpen,
            onSelect: () => (waveOpen ? setWaveOpen(false) : void openWaveform()),
          },
          {
            label: "Show selection in waveform",
            disabled: (status?.selection ?? 0) === 0,
            onSelect: () => void showInWaveform(),
          },
          { kind: "sep" },
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
    sim,
    simVersion,
    waveOpen,
    openWaveform,
    showInWaveform,
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

  // DEV hook: e2e asks for a close, so the guard's prompt is reachable in the
  // browser build (where there is no Tauri close request to intercept).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __circuitRequestClose?: () => Promise<boolean> };
    w.__circuitRequestClose = () => guardCloseRef.current?.() ?? Promise.resolve(true);
    return () => {
      delete w.__circuitRequestClose;
    };
  }, []);

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
      // Inline register value editing (#1/#2): with a register selected, typing
      // edits its value in place on the canvas (no Inspector field). Enter
      // pokes it, Esc cancels, Backspace deletes.
      if (!mod && inspectorCompId !== null) {
        const sel = doc.circuit(sheet).components.find((c) => c.id === inspectorCompId);
        if (sel?.type === "mem.register") {
          const edit = sim.registerEdit();
          const editing = edit?.compId === sel.id ? edit.text : null;
          // A poke is only meaningful while the clock is paused: the play loop
          // steps whole cycles, so a pause lands on a cycle boundary and the
          // forced value takes effect for exactly that cycle. While running we
          // block the edit and hint once per burst.
          if (sim.store.status?.running ?? false) {
            if (editing === null && e.key.length === 1) {
              const radix = typeof sel.attrs?.radix === "string" ? sel.attrs.radix : "hex";
              const accepts =
                radix === "bin" ? /^[01]$/ : radix === "hex" ? /^[0-9a-fA-F]$/ : /^[0-9]$/;
              if (accepts.test(e.key)) {
                e.preventDefault();
                if (Date.now() - pokeHintRef.current > 2000) {
                  pokeHintRef.current = Date.now();
                  toast("Pause the clock (Ctrl+K) to force a register value");
                }
                return;
              }
            }
            return;
          }
          if ((e.key === "Escape" || e.key === "Enter") && editing !== null) {
            e.preventDefault();
            sim.clearRegisterEdit();
            return;
          }
          if (e.key === "Backspace" && editing !== null) {
            e.preventDefault();
            const next = editing.slice(0, -1);
            if (next === "") sim.clearRegisterEdit();
            else applyRegInput(sel, next);
            return;
          }
          if (e.key.length === 1) {
            const radix = typeof sel.attrs?.radix === "string" ? sel.attrs.radix : "hex";
            const accepts =
              radix === "bin" ? /^[01]$/ : radix === "hex" ? /^[0-9a-fA-F]$/ : /^[0-9]$/;
            if (accepts.test(e.key)) {
              e.preventDefault();
              // Append at the least-significant digit and poke IMMEDIATELY —
              // no Enter needed (each keystroke is one new digit).
              applyRegInput(sel, (editing ?? "") + e.key);
              return;
            }
          }
        }
      }
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
      if (mod && e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (waveOpen) setWaveOpen(false);
        else void openWaveform();
        return;
      }
      if (e.key === "?") setShowHelp((v) => !v);
      if (e.key === "Escape") setShowHelp(false);
      // `/` jumps to the palette search (§94) — the GitHub/Slack convention.
      if (e.key === "/" && !mod && !e.altKey && paletteSearchRef.current !== null) {
        e.preventDefault();
        paletteSearchRef.current.focus();
        paletteSearchRef.current.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    onOpen,
    onSave,
    onSaveAs,
    openHistory,
    openWaveform,
    waveOpen,
    inspectorCompId,
    doc,
    sheet,
    applyRegInput,
    sim,
    toast,
  ]);

  /** The bar shows the file name; the app name lives on the logo's tooltip. */
  const docTitle = filePath === null ? "(unsaved)" : baseName(filePath);

  /**
   * One palette tile (UI_OVERHAUL §94): the same button whether it sits in its
   * own group or in a search result, where `note` names the group it came from.
   */
  const paletteTile = (item: PaletteItem, note?: string) => {
    const spec = compSpec(item.type);
    const label = item.label ?? spec.label ?? spec.caption({});
    const seed = { ...(placementAttrs(item.type) ?? {}), ...item.attrs };
    return (
      <button
        key={`${item.type}:${item.label ?? ""}`}
        className={`palette-item${status?.placing === item.type ? " active" : ""}`}
        draggable
        onClick={(e) =>
          editorRef.current?.startPlacing(
            item.type,
            e.shiftKey,
            Object.keys(seed).length === 0 ? undefined : seed,
            item.rot,
            item.name,
          )
        }
        onDragStart={(e) => {
          e.dataTransfer.setData("text/x-csx-type", item.type);
          if (item.attrs !== undefined) {
            e.dataTransfer.setData("text/x-csx-attrs", JSON.stringify(item.attrs));
          }
          if (item.rot !== undefined) e.dataTransfer.setData("text/x-csx-rot", item.rot);
          if (item.name !== undefined) e.dataTransfer.setData("text/x-csx-name", item.name);
        }}
        title={typeDisplayName(item.type)}
      >
        <CompIcon type={item.type} attrs={item.attrs} />
        <span className="palette-item-label">{label}</span>
        {note !== undefined && <span className="palette-item-note">{note}</span>}
      </button>
    );
  };

  /**
   * A subcircuit's tile: place an instance of that definition (§80). The note
   * says where the definition is already placed — the one thing the palette
   * cannot otherwise tell you — unless a search result names the group instead.
   */
  const subcircuitTile = (c: CsxCircuit, note = usedByText(doc.circuits, c.name)) => (
    <button
      key={`sub:${c.name}`}
      className={`palette-item${status?.placing === "subcircuit" ? " active" : ""}`}
      draggable
      onClick={(e) =>
        editorRef.current?.startPlacing("subcircuit", e.shiftKey, { circuit: c.name })
      }
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-csx-type", "subcircuit");
        e.dataTransfer.setData("text/x-csx-attrs", JSON.stringify({ circuit: c.name }));
      }}
      title={`Place an instance of "${c.name}" — its interface is the circuit's named pin components`}
    >
      <CompIcon type="subcircuit" />
      <span className="palette-item-label">{c.name}</span>
      <span className="palette-item-note">{note}</span>
    </button>
  );

  /**
   * Palette search (§94): every tile whose label, full name, type string or
   * group contains the query, plus the other sheets' subcircuits. Null when
   * the box is empty, so the rail's group view shows instead.
   */
  const paletteNeedle = paletteQuery.trim().toLowerCase();
  const paletteResults =
    paletteNeedle === ""
      ? null
      : [
          ...PALETTE.flatMap((g) =>
            g.items
              .filter((item) => {
                const spec = compSpec(item.type);
                const label = item.label ?? spec.label ?? spec.caption({});
                return [label, typeDisplayName(item.type), item.type, g.group].some((s) =>
                  s.toLowerCase().includes(paletteNeedle),
                );
              })
              .map((item) => ({ kind: "part" as const, item, group: g.group })),
          ),
          ...doc.circuits
            .filter(
              (c, i) => i !== sheet && `subcircuit ${c.name}`.toLowerCase().includes(paletteNeedle),
            )
            .map((c) => ({ kind: "sub" as const, circuit: c })),
        ];

  /**
   * An empty sheet shows a hint where the circuit will go (§94): what the
   * palette is for and how to move around. It never takes pointer events, so
   * placing the first part lands exactly where it would have anyway.
   */
  const activeCircuit = doc.circuits[sheet];
  const sheetEmpty =
    activeCircuit !== undefined &&
    activeCircuit.components.length === 0 &&
    activeCircuit.wires.length === 0;

  return (
    <div className="app" data-theme={theme} data-accent={accent}>
      <AppHeader
        logo={<AppLogoIcon />}
        title={stress ? "stress harness — ?stress=1" : docTitle}
        titleTooltip={stress ? undefined : (filePath ?? undefined)}
        renameValue={stress ? undefined : renameValue}
        onRename={stress ? undefined : renameFile}
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
              waveOpen={waveOpen}
              onToggleWave={() => (waveOpen ? setWaveOpen(false) : void openWaveform())}
              onLocateError={locateLoadError}
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
                <span className="topbar-sep" aria-hidden="true" />
                <button
                  className="icon-btn"
                  aria-label="Version history"
                  title="Version history (Ctrl+Alt+H)"
                  onClick={() => void openHistory()}
                >
                  <HistoryIcon />
                </button>
                <span className="topbar-sep" aria-hidden="true" />
                {/* Settings is also under File; the gear is the discoverable door. */}
                <button
                  className="icon-btn"
                  aria-label="Settings"
                  title="Settings — theme, canvas, editing, autosave"
                  onClick={() => setSettingsOpen(true)}
                >
                  <SettingsIcon />
                </button>
              </>
            )}
          </>
        }
      />
      {/* While the history view is open it owns the viewport, so it carries a
          modifier the editor row is hidden by (§76). */}
      <main className={`app-main${historyOpen ? " history" : ""}${waveOpen ? " wave" : ""}`}>
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
                {/* Find a part by name across every group (UI_OVERHAUL §94). */}
                <label className="palette-search">
                  <SearchIcon />
                  <input
                    ref={paletteSearchRef}
                    type="search"
                    value={paletteQuery}
                    placeholder="Search"
                    title="Find a part in any group (press / to jump here)"
                    aria-label="Search parts"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setPaletteQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Escape") return;
                      e.stopPropagation(); // the canvas must not also cancel its tool
                      setPaletteQuery("");
                      e.currentTarget.blur();
                    }}
                  />
                </label>
                {paletteResults !== null ? (
                  <>
                    <div className="palette-group-title">
                      {paletteResults.length === 0
                        ? "No matching parts"
                        : `${paletteResults.length} match${paletteResults.length === 1 ? "" : "es"}`}
                    </div>
                    <div
                      className="palette-group palette-results"
                      role="list"
                      aria-label="Matching parts"
                    >
                      {paletteResults.map((r) =>
                        r.kind === "part"
                          ? paletteTile(r.item, r.group)
                          : subcircuitTile(r.circuit, "Subcircuit"),
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="palette-group-title">{activePaletteGroup}</div>
                    <div className="palette-group" role="tabpanel" aria-label={activePaletteGroup}>
                      {activePaletteGroup === "Subcircuits" && doc.circuits.length === 1 && (
                        <p className="palette-hint">
                          No subcircuits yet. Make one, then place instances of it on any sheet.
                        </p>
                      )}
                      {activePaletteGroup === "Subcircuits" && (
                        <button className="palette-new" onClick={onNewSheet}>
                          + New subcircuit
                        </button>
                      )}
                      {activePaletteGroup === "Subcircuits"
                        ? doc.circuits.map((c, i) => i !== sheet && subcircuitTile(c))
                        : (PALETTE.find((g) => g.group === activePaletteGroup)?.items ?? []).map(
                            (item) => paletteTile(item),
                          )}
                    </div>
                  </>
                )}
              </div>
            </aside>
            {/* Circuit tabs live above the CANVAS column (UI_OVERHAUL §15), so
             * the side panels run the full height — no dead strip above the
             * palette (that empty band was the "gap"). */}
            <div className="editor-col">
              <SheetTabs
                sheets={doc.circuits.map((c) => c.name)}
                active={sheet}
                onSwitch={switchSheet}
                onNew={onNewSheet}
                onRename={onRenameSheet}
                onDelete={onDeleteSheet}
                onClose={onCloseSheet}
                hidden={hiddenSheets}
                renaming={renamingSheet}
                onCommitRename={onCommitSheetName}
                onCancelRename={onCancelSheetName}
                enterIdx={enteringSheet}
                scopeHue={scope}
              />
              <div className="editor-wrap">
                <EditorCanvas
                  pulseMs={Math.round((PULSE_MS * 100) / pulseSpeed)}
                  ref={editorRef}
                  doc={doc}
                  themeName={`${theme}|${accent}`}
                  sheetIdx={sheet}
                  onStatus={onStatus}
                  onEditComponent={(_id, focus) => setInspectorFocus(focus ?? null)}
                  onOpenSubcircuit={onOpenSubcircuit}
                  instancePath={instancePath}
                  onCanvasMenu={setCanvasMenu}
                  onNotify={toast}
                  sim={sim}
                  pathIds={pathIds}
                  pulsesOn={pulsesOn}
                  gridOn={gridOn}
                  showValues={showValues}
                  showPerf={showPerf}
                />
                {/* §94: an empty sheet says what goes here. Hidden the moment a
                    part is being placed, so the ghost has the canvas to itself. */}
                {sheetEmpty && !status?.placing && (
                  <div className="canvas-empty">
                    <div className="canvas-empty-card">
                      <span className="canvas-empty-glyph" aria-hidden="true">
                        <AppLogoIcon />
                      </span>
                      <p className="canvas-empty-title">
                        {inInstance || scope !== null ? "This sheet is empty" : "Start a circuit"}
                      </p>
                      <p className="canvas-empty-text">
                        Pick a part from the palette, then click the canvas to place it. Click a pin
                        to start a wire.
                      </p>
                      <ul className="canvas-empty-hints">
                        <li>
                          <kbd>Wheel</kbd> zoom
                        </li>
                        <li>
                          <kbd>Right-drag</kbd> pan
                        </li>
                        <li>
                          <kbd>?</kbd> shortcuts
                        </li>
                      </ul>
                    </div>
                  </div>
                )}
                {/* §80: inside a definition, the way out — named after a sheet that
                    really instantiates it — and where it is used. */}
                {(scope !== null || inInstance) && sheetName !== undefined && (
                  <div
                    className={`scope-bar${inInstance ? " scope-bar--instance" : ""}`}
                    style={{ "--scope-hue": String(scope ?? 0) } as CSSProperties}
                  >
                    <button
                      className="scope-back"
                      onClick={() => {
                        if (inInstance) {
                          exitInstance();
                          return;
                        }
                        const i = doc.circuitIdxByName(scopeParentName ?? "");
                        if (i >= 0) setSheet(i);
                      }}
                    >
                      ‹ {inInstance ? "out" : scopeParentName}
                    </button>
                    <span className="scope-name">
                      {inInstance ? `instance ${instanceLeaf} · ${sheetName}` : sheetName}
                    </span>
                    <span className="scope-note">
                      {inInstance
                        ? `a specific INSTANCE (${instancePath}) — these are its values, red means instance`
                        : usedByText(doc.circuits, sheetName)}
                    </span>
                  </div>
                )}
                {/* §77: the scope frame. A subcircuit sheet is a different scope,
                    and this says so without touching a single drawing. Inside an
                    INSTANCE it goes red (CE's own cue that you are watching one
                    instance, not the class). */}
                {(scope !== null || inInstance) && (
                  <div
                    className={`scope-frame${inInstance ? " scope-frame--instance" : ""}`}
                    style={{ "--scope-hue": String(scope ?? 0) } as CSSProperties}
                    aria-hidden="true"
                  />
                )}
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
                criticalPathNs={criticalPathNs}
                selectionCount={selectedComps.length}
                circuitIdx={sheet}
                circuits={doc.circuits.filter((_, i) => i !== sheet).map((c) => c.name)}
                sheetCircuits={doc.circuits}
                wireIdx={inspectorWireIdx}
                filePath={filePath}
                onEdit={() => editorRef.current?.refresh()}
                onOpenCircuit={onOpenSubcircuit}
                onNotify={toast}
                onShowInWaveform={() => void showInWaveform()}
                focusField={inspectorFocus}
                onFocusHandled={() => setInspectorFocus(null)}
              />
            </aside>
          </>
        )}
        {waveOpen && (
          <WaveformView
            sim={sim}
            defaults={waveDefaults}
            picked={wavePicked}
            add={waveAdd}
            watches={waveWatches}
            circuitLabel={doc.circuits[sheet]?.name ?? ""}
            onClose={() => setWaveOpen(false)}
            onNotify={toast}
          />
        )}
        {historyOpen && (
          <div className="history-view">
            {historySelectedId !== null && historyPreview !== null ? (
              <div className="history-preview">
                <div className="history-preview-bar">
                  <span className="history-preview-text">
                    Viewing an older version — {previewLabel}
                    {diffHighlight.length > 0 &&
                      ` · ${diffHighlight.length} part${
                        diffHighlight.length === 1 ? "" : "s"
                      } highlighted`}
                  </span>
                  <button onClick={() => void restoreVersion(historySelectedId)}>
                    Restore this version
                  </button>
                  <button className="secondary" onClick={() => setHistorySelectedId(null)}>
                    Back to current
                  </button>
                </div>
                <HistoryPreview
                  key={historySelectedId}
                  text={historyPreview}
                  themeName={`${theme}|${accent}`}
                  gridOn={gridOn}
                  showValues={showValues}
                  changedIds={diffHighlight}
                />
              </div>
            ) : (
              <div className="history-preview-empty">
                <p>
                  {versions.length === 0
                    ? "No versions yet — save the file to start the history."
                    : "Pick a version on the right to preview it here."}
                </p>
              </div>
            )}
            <HistoryDrawer
              versions={versions}
              selectedId={historySelectedId}
              usage={historyUsage}
              diff={versionDiff}
              onSelect={setHistorySelectedId}
              onRename={renameVersion}
              onClose={closeHistory}
              onNotify={toast}
            />
          </div>
        )}
      </main>
      <footer className="app-statusbar">
        {(scope !== null || inInstance) && (
          <span
            className={`statusbar-scope${inInstance ? " statusbar-scope--instance" : ""}`}
            style={{ "--scope-hue": String(scope ?? 0) } as CSSProperties}
          >
            {inInstance
              ? `inside INSTANCE ${instancePath} of ${sheetName} — showing this instance's live values`
              : `in ${sheetName} — instances follow this definition`}
          </span>
        )}
        {status?.placing && (
          <span>placing {status.placing} — click to drop, R rotate, Esc cancel</span>
        )}
        {status?.wiring && (
          <span>wiring — click a pin to finish, click to plant a bend, Esc cancel</span>
        )}
        {status !== null && status.selection > 0 && <span>{status.selection} selected</span>}
        {status?.cursor && (
          <span className="statusbar-coords" title="Pointer position, in grid units">
            {status.cursor.x.toFixed(1)}, {status.cursor.y.toFixed(1)}
          </span>
        )}
        <span className="statusbar-hint">
          press <kbd>?</kbd> for shortcuts
        </span>
      </footer>
      <div className="toast-stack">
        {toasts.map((t) => (
          <button
            type="button"
            className={`toast${t.closing ? " closing" : ""}`}
            key={t.id}
            title="Dismiss"
            onClick={() => dismissToast(t.id)}
          >
            {t.text}
          </button>
        ))}
      </div>
      {canvasMenu !== null && (
        <CanvasMenu menu={canvasMenu} onAction={onCanvasMenuAction} onClose={closeCanvasMenu} />
      )}
      {showAbout && <AboutCard onClose={() => setShowAbout(false)} />}
      {settingsOpen && (
        <SettingsDialog
          theme={theme}
          accent={accent}
          pulsesOn={pulsesOn}
          gridOn={gridOn}
          time24h={time24h}
          autosaveOn={autosaveOn}
          autosaveFileOn={autosaveFileOn}
          showValues={showValues}
          showPerf={showPerf}
          defaultBits={defaultBits}
          defaultInputs={defaultInputs}
          pauseOnUnknown={pauseOnUnknown}
          onPauseOnUnknown={setPauseOnUnknown}
          defaultHz={hzExp}
          updateCheckOn={updateCheckOn}
          onTheme={setTheme}
          onAccent={setAccent}
          onPulses={setPulsesOn}
          onGrid={setGridOn}
          onTime24h={setTime24h}
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

          pulseSpeed={pulseSpeed}
          onPulseSpeed={setPulseSpeed}
        />
      )}
      {closeAsk !== null && <ClosePrompt name={closeAsk.name} onChoose={closeAsk.resolve} />}
      {confirmAsk !== null && (
        <ConfirmDialog
          title={confirmAsk.title}
          body={confirmAsk.body}
          confirmLabel={confirmAsk.confirmLabel}
          danger
          onConfirm={() => {
            const run = confirmAsk.onConfirm;
            setConfirmAsk(null);
            run();
          }}
          onCancel={() => setConfirmAsk(null)}
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
        <div
          className="help-overlay"
          role="dialog"
          aria-label="Keyboard & mouse"
          onClick={() => setShowHelp(false)}
        >
          <div className="help-card help-shortcuts" onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <h2>Keyboard &amp; mouse</h2>
              <button className="help-close" aria-label="Close" onClick={() => setShowHelp(false)}>
                ×
              </button>
            </div>
            <div className="help-sections">
              {HELP_SECTIONS.map((s) => (
                <section className="help-section" key={s.title}>
                  <h3>{s.title}</h3>
                  {s.rows.map(([k, v]) => (
                    <div className="help-row" key={k}>
                      <span className="help-key">{k}</span>
                      <span className="help-desc">{v}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
            <p className="help-dismiss">Esc or click outside to dismiss</p>
          </div>
        </div>
      )}
    </div>
  );
}
