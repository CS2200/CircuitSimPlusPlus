import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { CircuitDocument } from "../model/document";
import type { CsxCircuit, CsxComponent, Rotation } from "../model/csx";
import {
  editableAttrs,
  compPins,
  negateList,
  parseNegateList,
  subcircuitSizeLimits,
  typeDisplayName,
  type AttrField,
} from "../editor/catalog";
import {
  evenSplit,
  formatSplitBits,
  parseSplitBits,
  resizeSplits,
  sortSplits,
  splitCoverage,
  splitEntries,
  type SplitCoverage,
  type SplitEntry,
} from "../editor/splits";
import { wireInfo } from "../model/wireInfo";
import { encodeRleHex, hexWidthFor, parseRleHex, wordsFromPasted } from "../lib/rleHex";
import { pickHexFile, relativeToCircuit } from "../files";
import MemContentsDialog from "./MemContentsDialog";
import NumberPicker from "./NumberPicker";
import { componentDelayText, wireDelayText } from "../editor/delayTable";
import Select from "./Select";
import { formatRadixValue, parseRadixValue } from "../lib/radix";
import CompIcon, { PaletteGroupIcon } from "./CompIcon";
import CircuitTree from "./CircuitTree";
import { WaveIcon } from "./icons";

/**
 * Inspector panel (frontend/UI_OVERHAUL.md §3): the component editor,
 * docked on the right and driven by the canvas selection. Replaces the
 * double-click modal (PropertiesDialog) — edits apply live:
 *
 *  - selects / checkboxes / rotation: committed immediately;
 *  - text + numbers: committed on Enter/blur (numbers also commit when the
 *    typed/spun value is in range, so steppers feel immediate);
 *  - every commit is one undoable op, and consecutive commits on the same
 *    field coalesce (a typing burst = one undo step).
 *
 * Reducing pin sets (gate inputs, mux selBits) still prunes wires to the
 * vanished pins — that is document semantics, unchanged.
 */

/** Component kinds the autograder addresses by name (docs/autograder.md §7). */
const ADDRESSABLE = new Set(["mem.ram", "mem.rom", "mem.register", "wiring.probe"]);

type Patch = {
  rot?: CsxComponent["rot"];
  name?: string;
  namePos?: CsxComponent["namePos"] | null;
  attrs?: Record<string, unknown>;
};

/** Preset wire colors (UI_OVERHAUL §12); theme-independent by design. */
const WIRE_COLORS = [
  "#e5534b",
  "#f0b43c",
  "#4dd0e1",
  "#40dc82",
  "#b478e6",
  "#f368a0",
  "#8a8a8a",
] as const;

/**
 * Drawn length of a wire's polyline in grid units (wire delay is per-path,
 * docs/delay-table.md).
 */
function pathLength(points: readonly [number, number][]): number {
  let len = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    len += Math.hypot(bx - ax, by - ay);
  }
  return len;
}

export default function InspectorPanel({
  doc,
  compId,
  selectionCount,
  circuitIdx = 0,
  circuits = [],
  sheetCircuits = [],
  wireIdx = null,
  criticalPathNs = null,
  filePath = null,
  onEdit,
  onNotify,
  onOpenCircuit,
  onShowInWaveform,
  focusField = null,
  onFocusHandled,
}: {
  doc: CircuitDocument;
  /** The single selected component, or null when there is no single selection. */
  compId: string | null;
  /** Total selected components (drives the multi-select empty state). */
  selectionCount: number;
  /** Sheet the component lives on (subcircuits are separate sheets). */
  circuitIdx?: number;
  /** All circuit names — the subcircuit target picker needs them. */
  circuits?: readonly string[];
  /** The document's circuits — pin geometry for subcircuit instances. */
  sheetCircuits?: readonly CsxCircuit[];
  /** The single selected wire (index in the current sheet), or null. */
  wireIdx?: number | null;
  /** Observed settle time of the critical path this part sits on (ns), else null. */
  criticalPathNs?: number | null;
  /** Current circuit file path (autoload paths resolve next to it). */
  filePath?: string | null;
  /** Called after any document mutation (canvas repaint + status refresh). */
  onEdit: () => void;
  /** User-facing messages (toasts). */
  onNotify?: (message: string) => void;
  /** Open a subcircuit definition sheet (the panel's way into an instance, §80). */
  onOpenCircuit?: (name: string) => void;
  /** Open the waveform viewer with the selection in it (§96). */
  onShowInWaveform?: () => void;
  /** Attr key to focus on the next render (double-click a constant, §53). */
  focusField?: string | null;
  onFocusHandled?: () => void;
}) {
  const circuit = doc.circuits[circuitIdx];
  const comp =
    compId === null || circuit === undefined
      ? undefined
      : circuit.components.find((x) => x.id === compId);

  // Focused-field draft text; committed on blur/Enter, dropped on selection
  // change. The reset keeps drafts that belong to the CURRENT component: the
  // effect can land a tick after a selection change, and clearing blindly
  // would clobber text typed immediately after clicking the new component
  // (the race that broke the e2e pin-rename flow). Stale drafts from other
  // components are always ignored by the `draft.key` checks anyway.
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(null);
  /** The Name field, so the load-error banner's Fix can land in it (§100). */
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusField !== "name") return;
    nameRef.current?.focus();
    nameRef.current?.select();
    onFocusHandled?.();
  }, [focusField, compId, onFocusHandled]);
  const [memOpen, setMemOpen] = useState(false);
  // Per-selection state (this draft, memOpen) resets because App remounts the
  // panel with a selection-scoped `key` — no reset effect/state needed.

  // Memory-image summary (words set in `attrs.contents`) — parsed only for
  // reasonably sized images; the Inspector re-renders on hover.
  const contentsImage =
    comp !== undefined && (comp.type === "mem.ram" || comp.type === "mem.rom")
      ? typeof comp.attrs?.contents === "string"
        ? comp.attrs.contents
        : undefined
      : undefined;
  const contentsWords = useMemo(() => {
    if (contentsImage === undefined) return 0;
    if (contentsImage.length > 8192) return -1; // large: skip the parse
    try {
      return parseRleHex(contentsImage).length;
    } catch {
      return -1;
    }
    // The React Compiler cannot preserve this memo (the panel still has patterns
    // it cannot compile); keep it — parsing RLE on every hover render is exactly
    // the cost this memo exists to avoid.
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
  }, [contentsImage]);

  const wire =
    comp === undefined && wireIdx !== null && circuit !== undefined
      ? { idx: wireIdx, info: wireInfo(circuit, wireIdx, (c) => compPins(c, sheetCircuits)) }
      : null;
  /** Draft key for the wire name field (per wire, so a stale draft is ignored). */
  const wireNameKey = wire === null ? "" : `${wire.idx}:name`;
  /** The wire's NAME (a tunnel label, UI_OVERHAUL §86) — read from the document. */
  const wireName = wire === null ? "" : (doc.circuit(circuitIdx).wires[wire.idx]?.name ?? "");
  const commitWireName = (text: string) => {
    const trimmed = text.trim();
    doc.setWireName(circuitIdx, wire!.idx, trimmed === "" ? null : trimmed);
    onEdit();
  };
  const wireColor =
    wire !== null && circuit !== undefined ? (circuit.wires[wire.idx]?.color ?? null) : null;
  /** The wire's drawn path length in grid units — its delay is per-path. */
  const wireLength =
    wire !== null && circuit !== undefined ? pathLength(circuit.wires[wire.idx]?.points ?? []) : 0;

  if (comp === undefined && wire !== null) {
    const setColor = (color: string | null) => {
      doc.setWireColor(circuitIdx, wire.idx, color);
      onEdit();
    };
    // A wire has no width of its own: it is inferred from the parts it joins
    // (its thickness already shows that). We only flag a genuine disagreement.
    return (
      <div className="inspector">
        <div className="inspector-head">
          <span className="inspector-glyph" aria-hidden="true">
            <PaletteGroupIcon group="Wiring" height={18} />
          </span>
          <span className="inspector-id">{wireName !== "" ? "Tunnel" : "Wire"}</span>
          {wireName !== "" && <span className="inspector-type">{wireName}</span>}
        </div>
        {/* A wire's NAME makes it a tunnel (UI_OVERHAUL §86/§87): its route is hidden
         * on the canvas and this label is the handle. Committed on Enter/blur, like a
         * part's name, so typing does not spam the undo stack. */}
        <label className="inspector-row">
          <span>Name</span>
          <input
            value={draft?.key === wireNameKey ? draft.text : wireName}
            placeholder="(plain wire)"
            title="A named wire is a tunnel: its route hides, and the label is how you find it"
            spellCheck={false}
            onChange={(e) => setDraft({ key: wireNameKey, text: e.target.value })}
            onBlur={() => {
              commitWireName(draft?.key === wireNameKey ? draft.text : wireName);
              setDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
        {/* Wire delay is per PATH (docs/delay-table.md): the drawn length times
         * the table's per-unit fraction — the design number, like a part's. */}
        {wireLength > 0 && (
          <div className="inspector-row">
            <span>Delay</span>
            <span className="inspector-file">{wireDelayText(wireLength)}</span>
          </div>
        )}
        {wire.info.widths.length > 1 && (
          <p className="inspector-note">
            ⚠ Width mismatch — this wire joins pins of different widths (
            {wire.info.widths.join(", ")} bits). A wire's width comes from the parts it connects;
            resize them so their widths agree.
          </p>
        )}
        <div className="inspector-row">
          <span>Color</span>
          <div className="wire-colors">
            <button
              className={`wire-swatch default${wireColor === null ? " active" : ""}`}
              aria-label="Default color"
              title="Default (state colors)"
              onClick={() => setColor(null)}
            />
            {WIRE_COLORS.map((c) => (
              <button
                key={c}
                className={`wire-swatch${wireColor === c ? " active" : ""}`}
                style={{ background: c }}
                aria-label={`Wire color ${c}`}
                title={c}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        {onShowInWaveform !== undefined && (
          <div className="inspector-buttons inspector-buttons-full">
            <button className="secondary" onClick={onShowInWaveform}>
              <WaveIcon />
              Show in waveform
            </button>
          </div>
        )}
      </div>
    );
  }

  if (comp === undefined) {
    // The empty dock is the circuit **navigator**: the hierarchy rooted at the
    // simulation root is always true of the document and needs no selection.
    // (A multi-selection keeps its "pick one" nudge instead.)
    const activeCircuit = doc.circuits[circuitIdx]?.name ?? doc.circuits[0]?.name ?? "";
    return (
      <div className="inspector">
        <div className="inspector-head">
          <span className="inspector-glyph" aria-hidden="true">
            <PaletteGroupIcon group="Subcircuits" height={18} />
          </span>
          <span className="inspector-id">Circuits</span>
        </div>
        {selectionCount > 1 ? (
          <div className="inspector-empty">
            <p className="inspector-empty-title">{selectionCount} parts selected</p>
            <p className="inspector-empty-text">
              Select exactly one part to edit its properties here.
            </p>
          </div>
        ) : (
          <div className="inspector-tree">
            <p className="settings-hint">
              Every circuit, nested from the simulation root. Click one to open its sheet.
            </p>
            <CircuitTree
              circuits={doc.circuits}
              activeName={activeCircuit}
              onOpen={(name) => onOpenCircuit?.(name)}
            />
            <p className="inspector-tree-help">
              <kbd>Click</kbd> a pin to start a wire · <kbd>R</kbd> rotates · <kbd>?</kbd> shortcuts
            </p>
          </div>
        )}
      </div>
    );
  }

  const commit = (patch: Patch, field: string) => {
    doc.updateComponent(circuitIdx, comp.id, patch, `edit:${circuitIdx}:${comp.id}:${field}`);
    onEdit();
  };
  const commitName = (name: string) => {
    if (name !== (comp.name ?? "")) commit({ name }, "name");
  };
  const commitRot = (rot: CsxComponent["rot"]) => {
    if (rot !== (comp.rot ?? "E")) commit({ rot }, "rot");
  };
  /** Per-part name-label side (§28/§31): Above (N) is the default and is
   * stored as "absent" so a default part writes nothing. */
  const commitNamePos = (side: Rotation) => {
    if (side === (comp.namePos ?? "N")) return;
    commit({ namePos: side === "N" ? null : side }, "namePos");
  };
  const commitAttr = (key: string, value: unknown) => {
    if ((comp.attrs ?? {})[key] === value) return;
    if (value === null && !(key in (comp.attrs ?? {}))) return; // already absent
    commit({ attrs: withoutNulls({ ...(comp.attrs ?? {}), [key]: value }) }, `attr:${key}`);
  };
  /**
   * Several attributes in ONE commit. Two `commitAttr` calls back to back would
   * each spread the same (stale) `comp.attrs`, so the second silently reverts
   * the first — e.g. "clear contents and the autoload file" undid itself.
   */
  const commitAttrs = (patch: Record<string, unknown>) => {
    const current = comp.attrs ?? {};
    // A re-pick of the cell that is already selected must not touch the file.
    if (Object.entries(patch).every(([key, value]) => current[key] === value)) return;
    commit(
      { attrs: withoutNulls({ ...current, ...patch }) },
      `attr:${Object.keys(patch).sort().join("+")}`,
    );
  };

  // Subcircuit instances pick their target from the file's circuits, not
  // free text (a typo would only surface as an engine load error).
  const subLimits =
    comp.type === "subcircuit" ? subcircuitSizeLimits(comp.attrs ?? {}, sheetCircuits) : null;
  const fields: AttrField[] = editableAttrs(comp.type).map((f): AttrField => {
    if (comp.type === "subcircuit" && f.key === "circuit") {
      return {
        key: "circuit",
        label: "Circuit",
        kind: "select" as const,
        options: circuits.map((c) => ({ value: c, label: c })),
      };
    }
    // The size sliders start at the smallest box the target's pins allow and
    // rest at the size it derives (§98) — both depend on the target circuit.
    if (subLimits !== null && f.kind === "slider" && (f.key === "width" || f.key === "height")) {
      const w = f.key === "width";
      return {
        ...f,
        min: w ? subLimits.minW : subLimits.minH,
        dflt: w ? subLimits.autoW : subLimits.autoH,
        max: subLimits.max,
      };
    }
    return f;
  });

  const unnamed = ADDRESSABLE.has(comp.type) && (comp.name ?? "") === "";
  /**
   * A `wiring.pin` MUST be named — a sheet's named pins are its subcircuit
   * interface, and `format/validate.rs` fails the WHOLE load on a blank one. So
   * this is a blocker, not the autograder nudge above.
   */
  const unnamedPin = comp.type === "wiring.pin" && (comp.name ?? "") === "";
  const nameKey = `${comp.id}:name`;
  /**
   * The editor's clock/reset convention (`editor/clockDefaults.ts`): a placed part wires
   * itself to a pin named `CLK` / `RST`, and any capitalisation of those words is accepted
   * when *finding* one. A different spelling is not an error — a wire's name is a label,
   * not a joining rule — but it will not be found, so this says so once.
   */
  const typed = (comp.name ?? "").trim();
  const clockAlias =
    comp.type === "wiring.pin" && /^(clk|clock|rst|reset)$/i.test(typed)
      ? /^(clk|clock)$/i.test(typed)
        ? { want: "CLK", is: typed }
        : { want: "RST", is: typed }
      : null;
  const clockAliasHint =
    clockAlias !== null && clockAlias.is !== clockAlias.want
      ? `Convention: ${clockAlias.want}. “${clockAlias.is}” still works — the name is a ` +
        `label — but the editor wires a placed part's clock and reset to the upper-case ` +
        `form, so this pin will not be found by default.`
      : null;

  // ---- memory images (UI_OVERHAUL §11): two loading methods ----
  const isMemory = comp.type === "mem.ram" || comp.type === "mem.rom";
  const memBits = typeof comp.attrs?.bitsize === "number" ? comp.attrs.bitsize : 1;
  const memDepth = typeof comp.attrs?.depth === "number" ? comp.attrs.depth : 256;
  const autoload = typeof comp.attrs?.autoload === "string" ? comp.attrs.autoload : "";

  /** Embed an image (browser mode / file outside the circuit folder). */
  const applyImage = (text: string, why: string) => {
    const { words, error } = wordsFromPasted(text, memBits, Math.max(memDepth, 1));
    if (error !== null) {
      onNotify?.(`Memory image: ${error}`);
      return;
    }
    commitAttr("contents", words.length === 0 ? null : encodeRleHex(words, hexWidthFor(memBits)));
    onNotify?.(`Embedded ${words.length} word${words.length === 1 ? "" : "s"} from ${why}`);
  };

  const chooseAutoload = async () => {
    let picked;
    try {
      picked = await pickHexFile();
    } catch (err) {
      onNotify?.(`File pick failed: ${String(err)}`);
      return;
    }
    if (picked === null) return;
    const rel =
      picked.path !== null && filePath !== null ? relativeToCircuit(filePath, picked.path) : null;
    if (rel !== null) {
      commitAttr("autoload", rel);
      onNotify?.(`Autoload: ${rel}`);
      return;
    }
    // No usable path (browser mode, unsaved file, or outside the circuit
    // folder): embed the image in the file so it works everywhere.
    applyImage(picked.text, `${picked.name} (embedded)`);
  };

  return (
    <div className="inspector">
      <div className="inspector-head">
        {/* The part's own glyph, then the plain, full component name —
         * "Multiplexer", not `plexers.mux` (UI_OVERHAUL §57); the id stays as
         * quiet metadata. */}
        <span className="inspector-glyph" aria-hidden="true">
          <CompIcon type={comp.type} attrs={comp.attrs ?? {}} height={18} />
        </span>
        <span className="inspector-id">{typeDisplayName(comp.type)}</span>
        <span className="inspector-type">{comp.id}</span>
      </div>

      {/* The part's own cost from the published delay table (docs/delay-table.md;
       * the values are read at build time, not copied). This is the DESIGN number
       * — what the timing report's `top_paths` observed on a run is a different
       * (measured) quantity, shown by the transport. */}
      {componentDelayText(comp.type) !== null && (
        <div className="inspector-row">
          <span>Delay</span>
          <span className="inspector-file">
            {componentDelayText(comp.type)}
            {criticalPathNs !== null ? ` · observed ${criticalPathNs} ns on the critical path` : ""}
          </span>
        </div>
      )}

      {/* A text annotation is just its text: no Name / Rotation / Label-side
       * rows — only the Text / Color / Font fields (UI_OVERHAUL §40/§42). */}
      {comp.type !== "misc.text" && (
        <label className="inspector-row">
          <span>Name</span>
          <input
            ref={nameRef}
            value={draft?.key === nameKey ? draft.text : (comp.name ?? "")}
            placeholder="(unnamed)"
            onChange={(e) => setDraft({ key: nameKey, text: e.target.value })}
            onBlur={() => {
              if (draft?.key === nameKey) {
                commitName(draft.text);
                setDraft(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
      )}

      {unnamedPin && (
        <p className="inspector-note" data-note="unnamed-pin">
          ⚠ Name this pin — a sheet&apos;s named pins are its subcircuit interface, and an unnamed
          pin stops the file from loading (format-v2 §5).
        </p>
      )}

      {clockAliasHint !== null && (
        <p className="inspector-note" data-note="clock-alias">
          ⓘ {clockAliasHint}
          {comp.name !== undefined && comp.name !== clockAlias?.want && (
            <>
              {" "}
              <button
                type="button"
                className="inspector-link"
                onClick={() => commit({ name: clockAlias?.want }, "name")}
              >
                Rename to {clockAlias?.want}
              </button>
            </>
          )}
        </p>
      )}

      {comp.type !== "misc.text" && (
        <div className="inspector-row">
          <span>Rotation</span>
          <Select
            label="Rotation"
            value={comp.rot ?? "E"}
            options={[
              { value: "E", label: "East" },
              { value: "S", label: "South" },
              { value: "W", label: "West" },
              { value: "N", label: "North" },
            ]}
            onChange={(rot) => commitRot(rot as CsxComponent["rot"])}
          />
        </div>
      )}

      {comp.type !== "misc.text" && (
        <div className="inspector-row">
          <span>Label side</span>
          <Select
            label="Label side"
            value={comp.namePos ?? "N"}
            options={[
              { value: "N", label: "Above" },
              { value: "S", label: "Below" },
              { value: "W", label: "Left" },
              { value: "E", label: "Right" },
            ]}
            onChange={(side) => commitNamePos(side as Rotation)}
          />
        </div>
      )}

      {fields.map((f) => (
        <Fragment key={f.key}>
          <FieldRow
            field={f}
            comp={comp}
            draft={draft}
            onDraft={setDraft}
            onCommitAttr={commitAttr}
            onCommitAttrs={commitAttrs}
            focusKey={focusField}
            onFocusHandled={onFocusHandled}
          />
          {f.hint !== undefined && <p className="settings-hint inspector-hint">{f.hint}</p>}
        </Fragment>
      ))}

      {isMemory && (
        <>
          <div className="inspector-sep" />
          <div className="inspector-subhead">Memory image</div>
          <div className="inspector-row">
            <span>Autoload</span>
            <span
              className="inspector-file"
              title={autoload === "" ? "no autoload file" : autoload}
            >
              {autoload === "" ? "None" : autoload}
            </span>
          </div>
          <div className="inspector-row">
            <span>Contents</span>
            <span className="inspector-file inspector-mem-contents">
              {contentsWords < 0
                ? "large image"
                : `${contentsWords} word${contentsWords === 1 ? "" : "s"}`}
            </span>
          </div>
          {/* One compact action line (UI_OVERHAUL §58). */}
          <div className="inspector-buttons">
            <button className="secondary" onClick={() => void chooseAutoload()}>
              Choose file…
            </button>
            {/* Clearing lives inside the editor (`Clear all`), so there is one
                clear control, not two that look alike but do different things. */}
            <button className="secondary" onClick={() => setMemOpen(true)}>
              Edit hex…
            </button>
          </div>
        </>
      )}

      {/* A subcircuit instance is a PLACE (UI_OVERHAUL §80): this is the panel's
       *  version of double-clicking the box on the sheet — one more door to the
       *  same definition, for whoever is looking at the panel instead. */}
      {comp?.type === "subcircuit" && (
        <div className="inspector-buttons inspector-buttons-full">
          <button
            className="secondary"
            disabled={typeof comp.attrs?.circuit !== "string" || comp.attrs.circuit === ""}
            onClick={() => {
              const target = comp.attrs?.circuit;
              if (typeof target === "string" && target !== "") onOpenCircuit?.(target);
            }}
          >
            Edit definition
          </button>
        </div>
      )}

      {/* The trace is one click from the part (§96): the value it drives (or,
       *  for a probe or LED, the value it reads) over time. */}
      {onShowInWaveform !== undefined &&
        comp.type !== "misc.text" &&
        compPins(comp, sheetCircuits).length > 0 && (
          <div className="inspector-buttons inspector-buttons-full">
            <button className="secondary" onClick={onShowInWaveform}>
              <WaveIcon />
              Show in waveform
            </button>
          </div>
        )}

      {memOpen && isMemory && (
        <MemContentsDialog
          depth={memDepth}
          bitsize={memBits}
          autoload={autoload}
          initial={contentsImage ?? null}
          onApply={(image, clearAutoload) => {
            commitAttrs(clearAutoload ? { contents: image, autoload: null } : { contents: image });
            onEdit();
          }}
          onClose={() => setMemOpen(false)}
        />
      )}

      {unnamed && (
        <p className="inspector-note">
          ⚠ Not autograder-addressable — give it a name (docs/autograder.md §7).
        </p>
      )}
    </div>
  );
}

/**
 * `null` means "clear this attr" (Auto on a size, Clear on a memory image), so it
 * is dropped rather than written into the file as `"width": null` (§98).
 */
function withoutNulls(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== null) out[k] = v;
  return out;
}

/** One splitter row in the editor's local state (UI_OVERHAUL §41). The pin name
 * is an invisible wire identity; `text` is the range spelling being edited. */
interface SplitRow {
  name: string;
  text: string;
}

function splitsToRows(value: unknown): SplitRow[] {
  return sortSplits(splitEntries(value)).map((entry) => ({
    name: entry.name,
    text: formatSplitBits(entry.bits),
  }));
}

/** A fresh internal pin name no existing row uses. */
function nextSplitName(rows: readonly SplitRow[]): string {
  const taken = new Set(rows.map((r) => r.name));
  for (let i = 0; ; i++) if (!taken.has(`b${i}`)) return `b${i}`;
}

/** Names for `count` rows, reusing the first existing names so wires stay put. */
function rowNames(count: number, rows: readonly SplitRow[]): string[] {
  const taken = new Set<string>();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    let name = rows[i]?.name ?? "";
    if (name === "" || taken.has(name)) {
      let n = 0;
      while (taken.has(`b${n}`) || rows.some((r) => r.name === `b${n}`)) n++;
      name = `b${n}`;
    }
    taken.add(name);
    names.push(name);
  }
  return names;
}

function rowsToSplits(rows: readonly SplitRow[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name !== "") out[name] = parseSplitBits(row.text).bits;
  }
  return out;
}

/**
 * One human line for a mapping the engine rejects, or null when it is legal.
 * Unmapped bus bits are allowed (the splitter may tap a subset of a bus); a bit
 * carried by two pins, or a split with no bits, is not.
 */
function coverageProblem(coverage: SplitCoverage, entries: readonly SplitEntry[]): string | null {
  const parts: string[] = [];
  const short = (bits: readonly number[]): string =>
    bits.length > 8 ? `${bits.slice(0, 8).join(", ")}…` : bits.join(", ");
  if (entries.some((e) => e.bits.length === 0)) {
    parts.push("each split must carry at least one bit");
  }
  if (coverage.duplicates.length > 0) {
    parts.push(`bits ${short(coverage.duplicates)} mapped more than once`);
  }
  return parts.length === 0 ? null : `Invalid mapping — ${parts.join("; ")}.`;
}

/**
 * Structured splitter editor (UI_OVERHAUL §41).
 *
 * The pin NAMES are wire identities, not labels, so they are hidden. Rows are
 * ordered by the bus bits they carry, and each row's field accepts a
 * comma-separated range spelling (`0-3`, `7-4` — the direction is meaningful)
 * that auto-formats back to ranges on commit. A mapping may leave bus bits
 * unmapped, so a splitter can tap just the fields it uses. The two numbers at
 * the very top are the total bus bits and the number of outputs: changing either
 * reflows the mapping (extend/truncate for bits, even split for outputs). Text
 * commits on blur/Enter, so a half-typed range never prunes wires mid-keystroke.
 */
function SplitsField({
  value,
  label,
  onCommit,
}: {
  value: unknown;
  label: string;
  onCommit: (v: Record<string, number[]>) => void;
}) {
  const [rows, setRows] = useState<SplitRow[]>(() => splitsToRows(value));
  const serialized = JSON.stringify(value ?? null);
  // Re-seed the editable rows when the committed value changes — adjust during
  // render rather than in an effect (compiler: no setState in effects).
  const [rowsFor, setRowsFor] = useState(serialized);
  if (rowsFor !== serialized) {
    setRowsFor(serialized);
    setRows(splitsToRows(JSON.parse(serialized)));
  }
  // Top fields keep their own draft while typing; they commit on Enter/blur.
  const [busDraft, setBusDraft] = useState<string | null>(null);
  const [outDraft, setOutDraft] = useState<string | null>(null);

  const parsed = rows.map((r) => parseSplitBits(r.text));
  const entries: SplitEntry[] = rows.map((r, i) => ({ name: r.name, bits: parsed[i].bits }));
  const coverage = splitCoverage(entries);
  const busBits = coverage.busBits;
  const outputs = rows.length;
  const parseError = parsed.map((p) => p.error).find((e) => e !== null) ?? null;
  const coverageError = coverageProblem(coverage, entries);

  /** Valid when every split carries at least one bit and no bus bit is carried
   * twice. Bus bits may be left unmapped. */
  const splitIsValid = (next: readonly SplitEntry[]): boolean => {
    if (next.length === 0 || next.some((e) => e.bits.length === 0)) return false;
    return splitCoverage(next).duplicates.length === 0;
  };
  const commitRows = (next: SplitRow[]): void => {
    setRows(next);
    // Invalid edits stay in the row (so the user can fix them) but are not
    // written to the document: the engine would reject the file.
    const entriesNext = next.map((r) => ({ name: r.name, bits: parseSplitBits(r.text).bits }));
    if (splitIsValid(entriesNext)) onCommit(rowsToSplits(next));
  };
  const commitEntries = (next: readonly SplitEntry[]): void => {
    commitRows(next.map((e) => ({ name: e.name, text: formatSplitBits(e.bits) })));
  };

  /** Removing a split merges its bits into the previous row, so they do not
   * silently become unmapped (or shorten the bus). */
  const removeRow = (index: number): void => {
    if (rows.length <= 1) return;
    const removed = rows[index];
    if (removed === undefined) return;
    const next = rows.filter((_, j) => j !== index);
    const target = next[Math.max(0, index - 1)];
    if (target !== undefined) {
      const merged = [...parseSplitBits(target.text).bits, ...parseSplitBits(removed.text).bits];
      next[Math.max(0, index - 1)] = { ...target, text: formatSplitBits(merged) };
    }
    commitRows(next);
  };

  const commitBus = (raw: string): void => {
    setBusDraft(null);
    const n = Math.round(Number(raw));
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    const clamped = Math.max(1, Math.min(32, n));
    if (clamped === busBits) return;
    commitEntries(resizeSplits(entries, clamped));
  };
  const commitOutputs = (raw: string): void => {
    setOutDraft(null);
    const n = Math.round(Number(raw));
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    const clamped = Math.max(1, Math.min(32, n));
    if (clamped === outputs) return;
    const slice = evenSplit(busBits, clamped);
    const names = rowNames(slice.length, rows);
    commitEntries(slice.map((bits, i) => ({ name: names[i], bits })));
  };

  /** Add a row carrying the next uncovered run, or one bit past the end. */
  const addRow = (): void => {
    const covered = new Set(entries.flatMap((e) => e.bits));
    let bit = 0;
    while (covered.has(bit)) bit++;
    if (bit >= busBits) {
      // Everything is mapped: extend the bus by one bit.
      commitRows([...rows, { name: nextSplitName(rows), text: String(busBits) }]);
      return;
    }
    const run: number[] = [];
    while (bit < busBits && !covered.has(bit)) {
      run.push(bit);
      bit++;
    }
    commitRows([...rows, { name: nextSplitName(rows), text: formatSplitBits(run) }]);
  };

  return (
    <div className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <div className="split-totals">
        <label className="split-total">
          <span>Bus bits</span>
          <input
            type="number"
            min={1}
            max={32}
            value={busDraft ?? String(busBits)}
            aria-label="Bus bits"
            onChange={(e) => setBusDraft(e.target.value)}
            onBlur={() => {
              if (busDraft !== null) commitBus(busDraft);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
        <label className="split-total">
          <span>Outputs</span>
          <input
            type="number"
            min={1}
            max={32}
            value={outDraft ?? String(outputs)}
            aria-label="Outputs"
            onChange={(e) => setOutDraft(e.target.value)}
            onBlur={() => {
              if (outDraft !== null) commitOutputs(outDraft);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
      </div>
      <div className="split-rows">
        {rows.map((r, i) => (
          <div className="split-row" key={r.name}>
            <span className="split-index" aria-hidden="true">
              {i + 1}
            </span>
            <input
              className="split-bits"
              value={r.text}
              placeholder="0-3"
              spellCheck={false}
              aria-label={`Split ${i + 1} bits`}
              onChange={(e) =>
                setRows(rows.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
              }
              onBlur={() => commitRows(rows)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <button
              className="secondary split-remove"
              aria-label={`Remove split ${i + 1}`}
              disabled={rows.length <= 1}
              onClick={() => removeRow(i)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="inspector-buttons inspector-buttons-full">
        <button className="secondary" onClick={addRow}>
          Add split
        </button>
      </div>
      <p className="settings-hint inspector-hint">
        {busBits} bit{busBits === 1 ? "" : "s"} · {outputs} output{outputs === 1 ? "" : "s"}
        {coverage.missing.length > 0 ? ` · ${coverage.missing.length} unmapped` : ""}
      </p>
      {(parseError !== null || coverageError !== null) && (
        <p className="inspector-note">⚠ {parseError ?? coverageError}</p>
      )}
    </div>
  );
}

function FieldRow({
  field,
  comp,
  draft,
  onDraft,
  onCommitAttr,
  onCommitAttrs,
  focusKey = null,
  onFocusHandled,
}: {
  field: AttrField;
  comp: CsxComponent;
  draft: { key: string; text: string } | null;
  onDraft: (d: { key: string; text: string } | null) => void;
  onCommitAttr: (key: string, value: unknown) => void;
  /** Several attrs at once (a pick that also resizes), never a stale spread. */
  onCommitAttrs: (patch: Record<string, unknown>) => void;
  /** Focus this row's input when it matches (UI_OVERHAUL §53). */
  focusKey?: string | null;
  onFocusHandled?: () => void;
}) {
  const key = `${comp.id}:attr:${field.key}`;
  const value = (comp.attrs ?? {})[field.key];
  const inputRef = useRef<HTMLInputElement>(null);

  // Double-clicking a constant lands here: jump straight into its value input.
  useEffect(() => {
    if (focusKey !== field.key) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    onFocusHandled?.();
  }, [focusKey, field.key, onFocusHandled]);

  if (field.kind === "slider" && field.typed === true) {
    // A size (§98): a track over the useful range, a number box for any legal
    // value, and — when the attr may be absent — Auto to derive it again.
    const set = typeof value === "number";
    const n = set ? Math.max(field.min, Math.min(field.max, value)) : field.dflt;
    const trackMax = Math.max(field.trackMax ?? field.max, n, field.min + 1);
    const pct = ((Math.min(n, trackMax) - field.min) / (trackMax - field.min)) * 100;
    const text = draft?.key === key ? draft.text : String(n);
    const commitTyped = (raw: string) => {
      const v = Math.round(Number(raw));
      if (raw.trim() !== "" && Number.isFinite(v)) {
        const clamped = Math.max(field.min, Math.min(field.max, v));
        if (clamped !== value) onCommitAttr(field.key, clamped);
      }
      onDraft(null);
    };
    return (
      <div className="inspector-field">
        <span className="inspector-field-label inspector-size-head">
          {field.label}
          {field.auto === true && (
            <button
              type="button"
              className={`inspector-auto${set ? "" : " active"}`}
              aria-pressed={!set}
              title={
                set
                  ? "Go back to the size the pins give it"
                  : "Following the pins — drag or type to set a size"
              }
              onClick={() => {
                if (set) onCommitAttr(field.key, null);
              }}
            >
              Auto
            </button>
          )}
        </span>
        <div className="inspector-slider inspector-size">
          <input
            type="range"
            min={field.min}
            max={trackMax}
            value={Math.min(n, trackMax)}
            aria-label={field.label}
            style={{ "--fill": `${pct}%` } as CSSProperties}
            onChange={(e) => onCommitAttr(field.key, Number(e.target.value))}
          />
          <input
            className="inspector-size-input"
            type="number"
            min={field.min}
            max={field.max}
            value={text}
            aria-label={`${field.label} (grid units)`}
            onChange={(e) => onDraft({ key, text: e.target.value })}
            onBlur={() => {
              if (draft?.key === key) commitTyped(draft.text);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                // Step from the shown value, so ↑ on "Auto 8" sets 9.
                e.preventDefault();
                const next = n + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 4 : 1);
                onCommitAttr(field.key, Math.max(field.min, Math.min(field.max, next)));
                onDraft(null);
              }
            }}
          />
        </div>
      </div>
    );
  }

  if (field.kind === "slider") {
    const n = typeof value === "number" ? value : field.dflt;
    const span = field.max - field.min;
    const pct = span <= 0 ? 0 : ((n - field.min) / span) * 100;
    return (
      <div className="inspector-row">
        <span>{field.label}</span>
        <div className="inspector-slider">
          <input
            type="range"
            min={field.min}
            max={field.max}
            value={n}
            aria-label={field.label}
            style={{ "--fill": `${pct}%` } as CSSProperties}
            onChange={(e) => onCommitAttr(field.key, Number(e.target.value))}
          />
          <span className="inspector-slider-value">{n}</span>
        </div>
      </div>
    );
  }

  if (field.kind === "number") {
    const n = typeof value === "number" ? value : undefined;
    const text = draft?.key === key ? draft.text : n === undefined ? "" : String(n);
    return (
      <label className="inspector-row">
        <span>{field.label}</span>
        <input
          type="number"
          min={field.min}
          max={field.max}
          value={text}
          placeholder={field.placeholder}
          onChange={(e) => {
            const raw = e.target.value;
            onDraft({ key, text: raw });
            const v = Number(raw);
            // In-range values commit immediately (steppers feel live);
            // out-of-range drafts wait for blur and are then discarded —
            // typing "16" into a 2..8 field never prunes wires en route.
            if (raw !== "" && Number.isFinite(v) && v >= field.min && v <= field.max) {
              const rounded = Math.round(v);
              if (rounded !== n) onCommitAttr(field.key, rounded);
              onDraft(null);
            }
          }}
          onBlur={() => {
            if (draft?.key === key) onDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
    );
  }

  if (field.kind === "picker") {
    const n =
      typeof value === "number"
        ? value
        : (field.derive?.(comp.attrs ?? {}) ?? field.dflt ?? field.min ?? 1);
    return (
      <div className="inspector-field">
        <span className="inspector-field-label">{field.label}</span>
        <NumberPicker
          value={n}
          min={field.min ?? 1}
          max={field.max ?? 32}
          label={field.label}
          onPick={(v) => onCommitAttrs(field.attrsFor?.(v, comp.attrs ?? {}) ?? { [field.key]: v })}
        />
      </div>
    );
  }

  if (field.kind === "splits") {
    return (
      <SplitsField value={value} label={field.label} onCommit={(v) => onCommitAttr(field.key, v)} />
    );
  }

  if (field.kind === "negate") {
    // A gate's input bubbles (`negate`) as a comma/space-separated list of input
    // indices — a field, not one checkbox per input (format-v2 §4). Parsed and
    // canonicalized on blur/Enter; empty clears the attr.
    const inputs = Math.max(2, typeof comp.attrs?.inputs === "number" ? comp.attrs.inputs : 2);
    const stored = negateList(value);
    const text = draft?.key === key ? draft.text : stored.join(", ");
    return (
      <label className="inspector-row">
        <span>{field.label}</span>
        <input
          value={text}
          placeholder={field.placeholder}
          spellCheck={false}
          aria-label={field.label}
          onChange={(e) => onDraft({ key, text: e.target.value })}
          onBlur={() => {
            if (draft?.key !== key) return;
            const next = parseNegateList(draft.text, inputs);
            const same = next.length === stored.length && next.every((v, i) => v === stored[i]);
            if (!same) onCommitAttr(field.key, next.length > 0 ? next : null);
            onDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
    );
  }

  if (field.kind === "select") {
    return (
      <div className="inspector-row">
        <span>{field.label}</span>
        <Select
          label={field.label}
          value={typeof value === "string" ? value : (field.options[0]?.value ?? "")}
          options={field.options}
          onChange={(v) => onCommitAttr(field.key, v)}
        />
      </div>
    );
  }

  if (field.kind === "color") {
    // A native swatch; empty (theme default) shows the app's text colour.
    const current = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#e6e6f0";
    return (
      <label className="inspector-row">
        <span>{field.label}</span>
        <input
          type="color"
          value={current}
          onChange={(e) => onCommitAttr(field.key, e.target.value)}
        />
      </label>
    );
  }

  if (field.kind === "radix") {
    // A segmented base chooser (UI_OVERHAUL §55) — three buttons, one active.
    const current = typeof value === "string" ? value : (field.options[0]?.value ?? "hex");
    return (
      <div className="inspector-field">
        <span className="inspector-field-label">{field.label}</span>
        <div className="radix-buttons" role="radiogroup" aria-label={field.label}>
          {field.options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === current}
              className={`radix-button${o.value === current ? " active" : ""}`}
              onClick={() => onCommitAttr(field.key, o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (field.kind === "radix-value") {
    // The constant's value, read and typed in its selected base (§55).
    const radix = typeof comp.attrs?.radix === "string" ? comp.attrs.radix : "hex";
    const bits = typeof comp.attrs?.bitsize === "number" ? comp.attrs.bitsize : 1;
    const hex = typeof value === "string" ? value : "0";
    const shown = draft?.key === key ? draft.text : formatRadixValue(hex, radix, bits);
    return (
      <label className="inspector-row">
        <span>{field.label}</span>
        <input
          ref={inputRef}
          value={shown}
          onChange={(e) => onDraft({ key, text: e.target.value })}
          onBlur={() => {
            if (draft?.key === key) {
              const parsed = parseRadixValue(draft.text, radix, bits);
              if (parsed !== null && parsed !== hex) onCommitAttr(field.key, parsed);
              onDraft(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
    );
  }

  if (field.kind === "boolean") {
    return (
      <label className="inspector-row">
        <span>{field.label}</span>
        <input
          type="checkbox"
          checked={value === undefined ? (field.dflt ?? false) : value === true}
          onChange={(e) =>
            onCommitAttr(
              field.key,
              field.nullWhenFalse ? (e.target.checked ? true : null) : e.target.checked,
            )
          }
        />
      </label>
    );
  }

  // text
  const text = draft?.key === key ? draft.text : typeof value === "string" ? value : "";
  return (
    <label className="inspector-row">
      <span>{field.label}</span>
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => onDraft({ key, text: e.target.value })}
        onBlur={() => {
          if (draft?.key === key) {
            onCommitAttr(field.key, draft.text);
            onDraft(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}
