import { CircuitDocument } from "../model/document";
import type { CsxEndpoint } from "../model/csx";
import { compPins } from "./catalog";
import { MOCK_DEMO_CIRCUIT, MOCK_DEMO_COMPS, MOCK_DEMO_GATE_COUNT } from "../ipc/mockDemoSpec";

/**
 * The mock-core demo circuit (U5): a counter — clock → register "pc" →
 * adder (+1) → back to pc.d, tapped by probe "next_pc" — plus a buffer
 * driving an 8-bit demo bus that floats while clk is low, and a 24-gate
 * bank feeding LEDs for wire traffic. Component order and the first 30
 * wires follow `src/ipc/mockDemoSpec.ts` exactly; everything after is
 * free-ordered (the mock finds constant nets by pin lookup).
 *
 * The gate bank fans out DLS-style: four vertical pcQ trunks (one per
 * column) with junction taps, likewise four constant trunks for in1.
 *
 * Reached via ?simdemo=1; the mock (VITE_MOCK_CORE=1) recognizes the top
 * circuit by name and animates it.
 */

const COLS = 4;
const ROWS = MOCK_DEMO_GATE_COUNT / COLS; // 6
const COL_X = (j: number) => 14 + j * 9;
const ROW_Y = (k: number) => 12 + k * 4;
/** Vertical trunk x per column (one grid unit left of the gates). */
const TRUNK_X = (j: number) => COL_X(j) - 1;

export function buildMockDemoDoc(): CircuitDocument {
  const doc = CircuitDocument.create("mock-demo");
  doc.renameCircuit(0, MOCK_DEMO_CIRCUIT);
  const c = 0;

  // Absolute position of a pin on a just-added component.
  const pinAt = (id: string, pin: string): [number, number] => {
    const comp = doc.circuit(c).components.find((x) => x.id === id);
    if (comp === undefined) throw new Error(`builder: missing comp ${id}`);
    const p = compPins(comp).find((x) => x.name === pin);
    if (p === undefined) throw new Error(`builder: ${comp.type} has no pin ${pin}`);
    return [comp.pos[0] + p.dx, comp.pos[1] + p.dy];
  };
  const wire = (a: CsxEndpoint, b: CsxEndpoint, pts: [number, number][]) =>
    doc.addWire(c, { a, b, points: pts });

  // --- components, in spec order (indices 0..5 are behavior-relevant) ---
  const clock = doc.addComponent(c, { type: "wiring.clock", pos: [2, 1] });
  const pc = doc.addComponent(c, { type: "mem.register", pos: [8, 1], name: "pc" });
  const adder = doc.addComponent(c, { type: "arith.adder", pos: [21, 1] });
  const nextPc = doc.addComponent(c, { type: "wiring.probe", pos: [31, 2], name: "next_pc" });
  doc.addComponent(c, { type: "mem.ram", pos: [2, 14], name: "imem" }); // unwired; U6 inspects it
  const buffer = doc.addComponent(c, { type: "gate.buffer", pos: [2, 5] });

  const gateType = (i: number) => ["gate.and", "gate.or", "gate.xor"][i % 3];
  const gateAt = (i: number): [number, number] => [COL_X(i % COLS), ROW_Y(Math.floor(i / COLS))];
  const gates: string[] = [];
  for (let i = 0; i < MOCK_DEMO_GATE_COUNT; i++) {
    gates.push(doc.addComponent(c, { type: gateType(i), pos: gateAt(i) }));
  }
  for (let i = 0; i < MOCK_DEMO_GATE_COUNT; i++) {
    const [gx, gy] = gateAt(i);
    doc.addComponent(c, { type: "io.led", pos: [gx + 7, gy + 1] });
  }
  const busProbe = doc.addComponent(c, { type: "wiring.probe", pos: [9, 5] });
  const constEn = doc.addComponent(c, {
    type: "wiring.constant",
    pos: [4, 4],
    attrs: { value: 1, bitsize: 1 },
  });
  const constOne = doc.addComponent(c, {
    type: "wiring.constant",
    pos: [17, 6],
    attrs: { value: 1 },
  });

  if (doc.circuit(c).components.length !== MOCK_DEMO_COMPS.ledBase + MOCK_DEMO_GATE_COUNT + 3) {
    throw new Error("builder: component order drifted from mockDemoSpec");
  }

  // --- wires 0..5, in spec order (behavior-relevant) ---
  // w0: clock.out → pc.clk
  wire({ comp: clock, pin: "out" }, { comp: pc, pin: "clk" }, [
    pinAt(clock, "out"),
    [6, 2],
    [6, 3],
    pinAt(pc, "clk"),
  ]);
  // w1: pc.q → adder.a
  wire({ comp: pc, pin: "q" }, { comp: adder, pin: "a" }, [pinAt(pc, "q"), pinAt(adder, "a")]);
  // w2: first pcQ trunk — pc.q down column 0 to its bottom gate's in0
  wire({ comp: pc, pin: "q" }, { comp: gates[COLS * (ROWS - 1)], pin: "in0" }, [
    pinAt(pc, "q"),
    [TRUNK_X(0), 2],
    [TRUNK_X(0), ROW_Y(ROWS - 1) + 1],
    pinAt(gates[COLS * (ROWS - 1)], "in0"),
  ]);
  // w3: adder.out → pc.d (the counter loop, routed over the top)
  wire({ comp: adder, pin: "out" }, { comp: pc, pin: "d" }, [
    pinAt(adder, "out"),
    [29, 3],
    [29, 0],
    [6, 0],
    [6, 2],
    pinAt(pc, "d"),
  ]);
  // w4: next_pc probe taps the loop wire (junction onto w3's vertical segment)
  doc.addWire(c, {
    a: { comp: nextPc, pin: "in" },
    b: { join: { wire: 3, segment: 1 } },
    points: [pinAt(nextPc, "in"), [29, 2.5]],
  });
  // w5: buffer.out → bus probe (floats while clk is low)
  wire({ comp: buffer, pin: "out" }, { comp: busProbe, pin: "in" }, [
    pinAt(buffer, "out"),
    [7, 6],
    [7, 5.5],
    pinAt(busProbe, "in"),
  ]);
  // w6..w29: gate outputs → LEDs
  const ledIds = doc
    .circuit(c)
    .components.filter((x) => x.type === "io.led")
    .map((x) => x.id);
  for (let i = 0; i < MOCK_DEMO_GATE_COUNT; i++) {
    wire({ comp: gates[i], pin: "out" }, { comp: ledIds[i], pin: "in" }, [
      pinAt(gates[i], "out"),
      pinAt(ledIds[i], "in"),
    ]);
  }

  // --- after w29 the order is free (mockDemoSpec stops caring) ---
  // Remaining pcQ trunks (columns 1..3), pc.q fan-out to bottom-gate in0.
  for (let j = 1; j < COLS; j++) {
    const bottom = gates[COLS * (ROWS - 1) + j];
    wire({ comp: pc, pin: "q" }, { comp: bottom, pin: "in0" }, [
      pinAt(pc, "q"),
      [TRUNK_X(j), 2],
      [TRUNK_X(j), ROW_Y(ROWS - 1) + 1],
      pinAt(bottom, "in0"),
    ]);
  }
  // Constant trunks (constOne → each column's bottom gate in1).
  for (let j = 0; j < COLS; j++) {
    const bottom = gates[COLS * (ROWS - 1) + j];
    const tx = TRUNK_X(j) + 0.5;
    wire({ comp: constOne, pin: "out" }, { comp: bottom, pin: "in1" }, [
      pinAt(constOne, "out"),
      [tx, 6.5],
      [tx, ROW_Y(ROWS - 1) + 2],
      pinAt(bottom, "in1"),
    ]);
  }
  // Junction taps: every non-bottom gate taps its column trunks.
  for (let i = 0; i < MOCK_DEMO_GATE_COUNT; i++) {
    const j = i % COLS;
    const k = Math.floor(i / COLS);
    if (k === ROWS - 1) continue; // bottom row is the trunks' endpoints
    const [gx, gy] = gateAt(i);
    doc.addWire(c, {
      a: { comp: gates[i], pin: "in0" },
      b: { join: { wire: j === 0 ? 2 : 30 + (j - 1), segment: 1 } },
      points: [
        [gx, gy + 1],
        [TRUNK_X(j), gy + 1],
      ],
    });
    doc.addWire(c, {
      a: { comp: gates[i], pin: "in1" },
      b: { join: { wire: 30 + (COLS - 1) + j, segment: 1 } },
      points: [
        [gx, gy + 2],
        [TRUNK_X(j) + 0.5, gy + 2],
      ],
    });
  }
  // enables / the +1 constant
  wire({ comp: constEn, pin: "out" }, { comp: pc, pin: "en" }, [
    pinAt(constEn, "out"),
    [6, 4.5],
    [6, 4],
    pinAt(pc, "en"),
  ]);
  wire({ comp: constOne, pin: "out" }, { comp: adder, pin: "b" }, [
    pinAt(constOne, "out"),
    [19, 6.5],
    [19, 4],
    pinAt(adder, "b"),
  ]);

  doc.markClean();
  doc.clearHistory();
  return doc;
}
