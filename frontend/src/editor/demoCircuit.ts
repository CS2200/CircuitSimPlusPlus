import { CircuitDocument } from "../model/document";

/**
 * A deterministic showcase circuit for visual review (U4) and screenshot
 * regression: every gate shape, bubbled variants, a mux, and 32-bit buses
 * (register → adder → probe) in a fixed layout. Reached via ?demo=1.
 */
export function buildDemoDoc(): CircuitDocument {
  const doc = CircuitDocument.create("demo");
  const c = 0;
  const gates = [
    "gate.and",
    "gate.or",
    "gate.xor",
    "gate.not",
    "gate.nand",
    "gate.nor",
    "gate.xnor",
    "gate.buffer",
  ];
  gates.forEach((type, i) => {
    doc.addComponent(c, {
      type,
      pos: [4 + (i % 4) * 10, 4 + Math.floor(i / 4) * 8],
      ...(type === "gate.nand" ? { attrs: { negateInputs: ["in1"] } } : {}),
    });
  });
  doc.addComponent(c, { type: "plexers.mux", pos: [4, 24], attrs: { selBits: 2 } });
  const reg = doc.addComponent(c, { type: "mem.register", pos: [16, 24], name: "acc" });
  const add = doc.addComponent(c, { type: "arith.adder", pos: [28, 24] });
  const probe = doc.addComponent(c, { type: "wiring.probe", pos: [38, 25], name: "sum" });
  const konst = doc.addComponent(c, {
    type: "wiring.constant",
    pos: [28, 32],
    attrs: { value: 1 },
  });
  // 32-bit bus: acc.q → add.a (with a bend), add.out → probe.in, const → add.b
  doc.addWire(c, {
    a: { comp: reg, pin: "q" },
    b: { comp: add, pin: "a" },
    points: [
      [22, 25],
      [25, 25],
      [25, 25.5],
      [28, 25.5],
    ],
  });
  doc.addWire(c, {
    a: { comp: add, pin: "out" },
    b: { comp: probe, pin: "in" },
    points: [
      [34, 26],
      [36, 26],
      [36, 25.5],
      [38, 25.5],
    ],
  });
  doc.addWire(c, {
    a: { comp: konst, pin: "out" },
    b: { comp: add, pin: "b" },
    points: [
      [30, 32.5],
      [30, 27],
      [28, 27],
    ],
  });
  // a junction: probe bus tapped onto the acc→add bus
  const tap = doc.addComponent(c, { type: "wiring.probe", pos: [24, 30], name: "acc_tap" });
  doc.addWire(c, {
    a: { comp: tap, pin: "in" },
    b: { join: { wire: 0, segment: 1 } },
    points: [
      [24, 30.5],
      [25, 25],
    ],
  });
  doc.markClean();
  doc.clearHistory();
  return doc;
}
