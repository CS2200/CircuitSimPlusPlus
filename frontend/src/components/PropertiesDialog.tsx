import { useEffect, useState } from "react";
import type { CircuitDocument } from "../model/document";
import type { CsxComponent } from "../model/csx";
import { editableAttrs, GATE_TYPE_OPTIONS, type AttrField } from "../editor/catalog";

/**
 * Properties dialog (double-click a component): edit name, rotation,
 * (gate) type, and per-type attrs (bitsize, inputs, selBits, …). Apply is
 * one undoable `updateComponent` op — the document prunes wires to pins
 * that no longer exist.
 */
export default function PropertiesDialog({
  doc,
  compId,
  circuitIdx = 0,
  onClose,
}: {
  doc: CircuitDocument;
  compId: string;
  /** Sheet the component lives on (subcircuits are separate sheets). */
  circuitIdx?: number;
  onClose: () => void;
}) {
  const comp = doc.circuit(circuitIdx).components.find((x) => x.id === compId);
  const [name, setName] = useState(comp?.name ?? "");
  const [type, setType] = useState(comp?.type ?? "");
  const [rot, setRot] = useState(comp?.rot ?? "E");
  const [attrs, setAttrs] = useState<Record<string, unknown>>({ ...(comp?.attrs ?? {}) });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (comp === undefined) return null;
  const fields = editableAttrs(type);

  const apply = () => {
    const patch: {
      type?: string;
      rot?: CsxComponent["rot"];
      name?: string;
      attrs?: Record<string, unknown>;
    } = {};
    if (type !== comp.type) patch.type = type;
    if (rot !== (comp.rot ?? "E")) patch.rot = rot as CsxComponent["rot"];
    if (name !== (comp.name ?? "")) patch.name = name;
    patch.attrs = attrs;
    doc.updateComponent(circuitIdx, compId, patch);
    onClose();
  };

  const setAttr = (key: string, value: unknown) => setAttrs((a) => ({ ...a, [key]: value }));

  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-card prop-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>
          {comp.id} <span className="prop-type">{comp.type}</span>
        </h2>
        <label className="prop-row">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="(unnamed)" />
        </label>
        <label className="prop-row">
          <span>Rotation</span>
          <select value={rot} onChange={(e) => setRot(e.target.value as "N" | "E" | "S" | "W")}>
            <option value="E">East</option>
            <option value="S">South</option>
            <option value="W">West</option>
            <option value="N">North</option>
          </select>
        </label>
        {comp.type.startsWith("gate.") && (
          <label className="prop-row">
            <span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {GATE_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t.slice(5).toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        )}
        {fields.map((f) => (
          <AttrFieldRow key={f.key} field={f} value={attrs[f.key]} onChange={setAttr} />
        ))}
        <div className="prop-actions">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button onClick={apply}>Apply</button>
        </div>
        {comp.type.startsWith("gate.") && fields.length > 0 && (
          <p className="help-dismiss">removing inputs deletes wires connected to them</p>
        )}
      </div>
    </div>
  );
}

function AttrFieldRow({
  field,
  value,
  onChange,
}: {
  field: AttrField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}) {
  if (field.kind === "number") {
    const n = typeof value === "number" ? value : undefined;
    return (
      <label className="prop-row">
        <span>{field.label}</span>
        <input
          type="number"
          min={field.min}
          max={field.max}
          value={n ?? ""}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) {
              onChange(field.key, Math.max(field.min, Math.min(field.max, Math.round(v))));
            }
          }}
        />
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label className="prop-row">
        <span>{field.label}</span>
        <select
          value={typeof value === "string" ? value : field.options[0].value}
          onChange={(e) => onChange(field.key, e.target.value)}
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
  return (
    <label className="prop-row">
      <span>{field.label}</span>
      <input
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(field.key, e.target.value)}
      />
    </label>
  );
}
