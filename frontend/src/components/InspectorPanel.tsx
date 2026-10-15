import { Fragment, useEffect, useMemo, useState } from "react";
import type { CircuitDocument } from "../model/document";
import type { CsxCircuit, CsxComponent, Rotation } from "../model/csx";
import { editableAttrs, compPins, GATE_TYPE_OPTIONS, type AttrField } from "../editor/catalog";
import { wireInfo } from "../model/wireInfo";
import { encodeRleHex, hexWidthFor, parseRleHex, wordsFromPasted } from "../lib/rleHex";
import { pickHexFile, relativeToCircuit } from "../files";
import MemContentsDialog from "./MemContentsDialog";
import NumberPicker from "./NumberPicker";
import Select from "./Select";

/**
 * Inspector panel (frontend/UI_OVERHAUL.md §3): the component editor,
 * docked on the right and driven by the canvas selection. Replaces the
 * double-click modal (PropertiesDialog) — edits apply live:
 *
 *  - selects / checkboxes / rotation / gate type: committed immediately;
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
  type?: string;
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
    const driver = wire.info.driver;
    const target =
      driver === null || circuit === undefined
        ? undefined
        : circuit.components.find((c) => c.id === driver.compId);
    const setColor = (color: string | null) => {
      doc.setWireColor(circuitIdx, wire.idx, color);
      onEdit();
    };
    const setWidth = (bits: number) => {
      if (driver === null || target === undefined) return;
      const value = Math.max(1, Math.min(32, Math.round(bits) || 1));
      doc.updateComponent(
        circuitIdx,
        driver.compId,
        { attrs: { ...(target.attrs ?? {}), bitsize: value } },
        `wirebits:${circuitIdx}:${driver.compId}`,
      );
      onEdit();
    };
    return (
      <div className="inspector">
        <div className="inspector-head">
          <span className="inspector-id">wire {wire.idx}</span>
          <span className="inspector-type">{wire.info.bitsize}-bit bus</span>
        </div>
        <div className="inspector-field">
          <span className="inspector-field-label">Width (bits)</span>
          <NumberPicker
            value={wire.info.bitsize}
            label="Width (bits)"
            onPick={(bits) => setWidth(bits)}
          />
          {driver === null && (
            <p className="settings-hint">
              No driving pin on this net — width comes from the source.
            </p>
          )}
        </div>
        {driver !== null && (
          <p className="settings-hint">
            width comes from {driver.compId}.{driver.pin}
          </p>
        )}
        {wire.info.widths.length > 1 && (
          <p className="inspector-note">
            Width mismatch: this net mixes {wire.info.widths.join(" / ")}-bit pins — the engine
            reports it at load.
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
  const commitType = (type: string) => {
    if (type !== comp.type) commit({ type }, "type");
  };
  const commitAttr = (key: string, value: unknown) => {
    if ((comp.attrs ?? {})[key] === value) return;
    commit({ attrs: { ...(comp.attrs ?? {}), [key]: value } }, `attr:${key}`);
  };
  /** wiring.pin direction flips mirror the default facing E ↔ W (as the dialog did). */
  const commitAsOutput = (isOutput: boolean) => {
    const patch: Patch = { attrs: { ...(comp.attrs ?? {}), isOutput } };
    const rot = comp.rot ?? "E";
    if (rot === "E" || rot === "W") patch.rot = rot === "E" ? "W" : "E";
    commit(patch, "attr:isOutput");
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
        <span className="inspector-id">{comp.id}</span>
        <span className="inspector-type">{comp.type}</span>
      </div>

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

      {comp.type.startsWith("gate.") && (
        <div className="inspector-row">
          <span>Type</span>
          <Select
            label="Type"
            value={comp.type}
            options={GATE_TYPE_OPTIONS.map((t) => ({ value: t, label: t.slice(5).toUpperCase() }))}
            onChange={(type) => commitType(type)}
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
            onCommitOutput={commitAsOutput}
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
          <div className="inspector-buttons inspector-buttons-full">
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
          </div>
          <div className="inspector-row">
            <span>Contents</span>
            <span className="inspector-file inspector-mem-contents">
              {contentsWords < 0
                ? "large image"
                : `${contentsWords} word${contentsWords === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="inspector-buttons inspector-buttons-full">
            <button className="secondary" onClick={() => setMemOpen(true)}>
              Edit hex…
            </button>
          </div>
          <p className="settings-hint">
            Loads a .hex file next to the circuit, or embeds pasted values in the file.
          </p>
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

/** `splits` object → `pin: bit,bit` lines (UI_OVERHAUL §18). */
function splitsToText(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value as Record<string, unknown>)
    .map(([name, bits]) => `${name}: ${Array.isArray(bits) ? bits.join(",") : ""}`)
    .join("\n");
}

/** `pin: bit,bit` lines → a `splits` object (null when nothing parses). */
function textToSplits(text: string): Record<string, number[]> | null {
  const out: Record<string, number[]> = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const bits = line
      .slice(colon + 1)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0);
    if (name !== "") out[name] = bits;
  }
  return Object.keys(out).length === 0 ? null : out;
}

function FieldRow({
  field,
  comp,
  draft,
  onDraft,
  onCommitAttr,
  onCommitOutput,
}: {
  field: AttrField;
  comp: CsxComponent;
  draft: { key: string; text: string } | null;
  onDraft: (d: { key: string; text: string } | null) => void;
  onCommitAttr: (key: string, value: unknown) => void;
  onCommitOutput: (isOutput: boolean) => void;
}) {
  const key = `${comp.id}:attr:${field.key}`;
  const value = (comp.attrs ?? {})[field.key];

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
    const text = draft?.key === key ? draft.text : splitsToText(value);
    return (
      <label className="inspector-field">
        <span className="inspector-field-label">{field.label}</span>
        <textarea
          className="inspector-textarea"
          value={text}
          rows={4}
          spellCheck={false}
          placeholder={field.placeholder}
          onChange={(e) => onDraft({ key, text: e.target.value })}
          onBlur={() => {
            if (draft?.key !== key) return;
            const parsed = textToSplits(draft.text);
            if (parsed !== null) onCommitAttr(field.key, parsed);
            onDraft(null);
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

  if (field.kind === "boolean") {
    return (
      <label className="inspector-row">
        <span>{field.label}</span>
        <input
          type="checkbox"
          checked={value === true}
          // wiring.pin direction also mirrors the pin's facing (E ↔ W).
          onChange={(e) =>
            field.key === "isOutput"
              ? onCommitOutput(e.target.checked)
              : onCommitAttr(field.key, e.target.checked)
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
