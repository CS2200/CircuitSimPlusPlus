import { useEffect, useState } from "react";
import type { CircuitDocument } from "../model/document";
import type { CsxComponent } from "../model/csx";
import { editableAttrs, GATE_TYPE_OPTIONS, type AttrField } from "../editor/catalog";

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
  attrs?: Record<string, unknown>;
};

export default function InspectorPanel({
  doc,
  compId,
  selectionCount,
  circuitIdx = 0,
  circuits = [],
  onEdit,
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
  /** Called after any document mutation (canvas repaint + status refresh). */
  onEdit: () => void;
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
  useEffect(() => {
    setDraft((d) => (d !== null && !d.key.startsWith(`${compId ?? ""}:`) ? null : d));
  }, [compId, circuitIdx]);

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

      <label className="inspector-row">
        <span>Rotation</span>
        <select
          value={comp.rot ?? "E"}
          onChange={(e) => commitRot(e.target.value as CsxComponent["rot"])}
        >
          <option value="E">East</option>
          <option value="S">South</option>
          <option value="W">West</option>
          <option value="N">North</option>
        </select>
      </label>

      {comp.type.startsWith("gate.") && (
        <label className="inspector-row">
          <span>Type</span>
          <select value={comp.type} onChange={(e) => commitType(e.target.value)}>
            {GATE_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t.slice(5).toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      )}

      {fields.map((f) => (
        <FieldRow
          key={f.key}
          field={f}
          comp={comp}
          draft={draft}
          onDraft={setDraft}
          onCommitAttr={commitAttr}
          onCommitOutput={commitAsOutput}
        />
      ))}

      {unnamed && (
        <p className="inspector-note">
          ⚠ Not autograder-addressable — give it a name (docs/autograder.md §7).
        </p>
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

  if (field.kind === "select") {
    return (
      <label className="inspector-row">
        <span>{field.label}</span>
        <select
          value={typeof value === "string" ? value : field.options[0].value}
          onChange={(e) => onCommitAttr(field.key, e.target.value)}
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
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
          onChange={(e) => onCommitOutput(e.target.checked)}
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
