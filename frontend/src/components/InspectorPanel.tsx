import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { CircuitDocument } from "../model/document";
import type { CsxCircuit, CsxComponent, Rotation } from "../model/csx";
import { editableAttrs, compPins, typeDisplayName, type AttrField } from "../editor/catalog";
import { wireInfo } from "../model/wireInfo";
import { encodeRleHex, hexWidthFor, parseRleHex, wordsFromPasted } from "../lib/rleHex";
import { pickHexFile, relativeToCircuit } from "../files";
import MemContentsDialog from "./MemContentsDialog";
import NumberPicker from "./NumberPicker";
import Select from "./Select";
import { formatRadixValue, parseRadixValue } from "../lib/radix";

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

export default function InspectorPanel({
  doc,
  compId,
  selectionCount,
  circuitIdx = 0,
  circuits = [],
  sheetCircuits = [],
  wireIdx = null,
  filePath = null,
  onEdit,
  onNotify,
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
  /** Current circuit file path (autoload paths resolve next to it). */
  filePath?: string | null;
  /** Called after any document mutation (canvas repaint + status refresh). */
  onEdit: () => void;
  /** User-facing messages (toasts). */
  onNotify?: (message: string) => void;
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
  const [memOpen, setMemOpen] = useState(false);
  useEffect(() => {
    setDraft((d) => (d !== null && !d.key.startsWith(`${compId ?? ""}:`) ? null : d));
    setMemOpen(false);
  }, [compId, circuitIdx]);

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
  }, [contentsImage]);

  const wire =
    comp === undefined && wireIdx !== null && circuit !== undefined
      ? { idx: wireIdx, info: wireInfo(circuit, wireIdx, (c) => compPins(c, sheetCircuits)) }
      : null;
  const wireColor =
    wire !== null && circuit !== undefined ? (circuit.wires[wire.idx]?.color ?? null) : null;

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
          <span className="inspector-id">Wire</span>
        </div>
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
      </div>
    );
  }

  if (comp === undefined) {
    return (
      <div className="inspector">
        <p className="inspector-empty">
          {selectionCount > 1
            ? `${selectionCount} components selected — select exactly one to edit.`
            : "Nothing selected. Click a component on the canvas to edit its properties here."}
        </p>
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
    commit({ attrs: { ...(comp.attrs ?? {}), [key]: value } }, `attr:${key}`);
  };

  // Subcircuit instances pick their target from the file's circuits, not
  // free text (a typo would only surface as an engine load error).
  const fields: AttrField[] = editableAttrs(comp.type).map((f) =>
    comp.type === "subcircuit" && f.key === "circuit"
      ? {
          key: "circuit",
          label: "Circuit",
          kind: "select" as const,
          options: circuits.map((c) => ({ value: c, label: c })),
        }
      : f,
  );

  const unnamed = ADDRESSABLE.has(comp.type) && (comp.name ?? "") === "";
  const nameKey = `${comp.id}:name`;

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
        {/* The plain, full component name — "Multiplexer", not `plexers.mux`
         * (UI_OVERHAUL §57); the id stays as quiet metadata. */}
        <span className="inspector-id">{typeDisplayName(comp.type)}</span>
        <span className="inspector-type">{comp.id}</span>
      </div>

      {/* A text annotation is just its text: no Name / Rotation / Label-side
       * rows — only the Text / Color / Font fields (UI_OVERHAUL §40/§42). */}
      {comp.type !== "misc.text" && (
        <label className="inspector-row">
          <span>Name</span>
          <input
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
            <button
              className="secondary"
              disabled={autoload === ""}
              onClick={() => {
                commitAttr("autoload", null);
                onNotify?.("Autoload cleared");
              }}
            >
              Clear
            </button>
            <button className="secondary" onClick={() => setMemOpen(true)}>
              Edit hex…
            </button>
          </div>
        </>
      )}

      {memOpen && isMemory && (
        <MemContentsDialog
          depth={memDepth}
          bitsize={memBits}
          initial={contentsImage ?? null}
          onApply={(image) => {
            commitAttr("contents", image);
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

/** One splitter-pin row in the editor's local state (UI_OVERHAUL §41). */
interface SplitRow {
  name: string;
  /** Comma-separated bit indices, kept as text while editing. */
  bits: string;
}

function splitsToRows(value: unknown): SplitRow[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([name, bits]) => ({
    name,
    bits: Array.isArray(bits) ? bits.join(", ") : "",
  }));
}

function rowsToSplits(rows: readonly SplitRow[]): Record<string, number[]> | null {
  const out: Record<string, number[]> = {};
  for (const r of rows) {
    const name = r.name.trim();
    if (name === "") continue;
    out[name] = r.bits
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0);
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Structured splitter editor (UI_OVERHAUL §41): one row per split pin with a
 * name and its bus-bit indices, plus add/remove — instead of a raw text box.
 * Text edits commit on blur/Enter (NOT per keystroke: a rename would drop the
 * old pin and prune its wires); add/remove commit immediately.
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
  useEffect(() => {
    setRows(splitsToRows(JSON.parse(serialized)));
  }, [serialized]);

  const commit = (next: SplitRow[]): void => {
    setRows(next);
    const parsed = rowsToSplits(next);
    if (parsed !== null) onCommit(parsed);
  };

  const bitCount = new Set(
    rows.flatMap((r) =>
      r.bits
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  ).size;

  return (
    <div className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <div className="split-rows">
        {rows.map((r, i) => (
          <div className="split-row" key={i}>
            <input
              className="split-name"
              value={r.name}
              placeholder="pin"
              spellCheck={false}
              aria-label={`Split pin ${i + 1} name`}
              onChange={(e) =>
                setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
              onBlur={() => commit(rows)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <input
              className="split-bits"
              value={r.bits}
              placeholder="0, 1"
              spellCheck={false}
              aria-label={`Split pin ${i + 1} bits`}
              onChange={(e) =>
                setRows(rows.map((x, j) => (j === i ? { ...x, bits: e.target.value } : x)))
              }
              onBlur={() => commit(rows)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <button
              className="secondary split-remove"
              aria-label={`Remove split pin ${r.name || i + 1}`}
              disabled={rows.length <= 1}
              onClick={() => commit(rows.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="inspector-buttons inspector-buttons-full">
        <button
          className="secondary"
          onClick={() => commit([...rows, { name: `b${rows.length}`, bits: "" }])}
        >
          Add pin
        </button>
      </div>
      <p className="settings-hint inspector-hint">
        {rows.length} pin{rows.length === 1 ? "" : "s"} · bus {bitCount} bit
        {bitCount === 1 ? "" : "s"}
      </p>
    </div>
  );
}

function FieldRow({
  field,
  comp,
  draft,
  onDraft,
  onCommitAttr,
  focusKey = null,
  onFocusHandled,
}: {
  field: AttrField;
  comp: CsxComponent;
  draft: { key: string; text: string } | null;
  onDraft: (d: { key: string; text: string } | null) => void;
  onCommitAttr: (key: string, value: unknown) => void;
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
    const n = typeof value === "number" ? value : (field.dflt ?? field.min ?? 1);
    return (
      <div className="inspector-field">
        <span className="inspector-field-label">{field.label}</span>
        <NumberPicker
          value={n}
          min={field.min ?? 1}
          max={field.max ?? 32}
          label={field.label}
          onPick={(v) => onCommitAttr(field.key, v)}
        />
      </div>
    );
  }

  if (field.kind === "splits") {
    return (
      <SplitsField value={value} label={field.label} onCommit={(v) => onCommitAttr(field.key, v)} />
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
          checked={value === true}
          onChange={(e) => onCommitAttr(field.key, e.target.checked)}
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
