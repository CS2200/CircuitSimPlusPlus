/**
 * Layout contract between the U9 mock core (src/ipc/mock.ts) and the demo
 * circuit builder (src/editor/mockDemoCircuit.ts).
 *
 * The mock simulates ONE fixed behavior — a counter with a floating demo
 * bus and a 24-gate traffic bank. When a document whose top circuit is
 * named `MOCK_DEMO_CIRCUIT` is loaded, the mock derives nets from the
 * document itself (same union-find as the editor) and locates its behavior
 * nets through these fixed wire indices, and its poke/halt targets through
 * these fixed component indices (= positions in the `components` array,
 * matching the contract's `CompId` convention, format-v2 §5). The builder
 * constructs components and wires in exactly this order, so the two sides
 * always agree.
 */

/** Top-circuit name that switches the mock from generic mode to demo mode. */
export const MOCK_DEMO_CIRCUIT = "mock-counter-demo";

export const MOCK_DEMO_GATE_COUNT = 24;

/** Component array indices (CompIds) of the demo circuit. */
export const MOCK_DEMO_COMPS = {
  clock: 0,
  pc: 1,
  adder: 2,
  nextPcProbe: 3,
  imem: 4,
  buffer: 5,
  /** Gate bank: indices 6..29. */
  gateBase: 6,
  /** LEDs after the gates: indices 30..53. */
  ledBase: 6 + MOCK_DEMO_GATE_COUNT,
} as const;

/**
 * Wire array indices. The mock maps its behavior nets through
 * `wireToNet` of the document's own derivation, so only the INDEX ORDER
 * matters here — junctions and fan-out may merge wires into shared nets.
 * Constant-driven nets (pc.en, adder.b) are found by PIN lookup, not wire
 * index, so the builder is free to order everything after `gateOut`.
 */
export const MOCK_DEMO_WIRES = {
  clk: 0,
  pcQ: 1,
  /** Second fan-out wire off pc.q (first gate-bank trunk). Same net. */
  pcQTrunk: 2,
  nextPc: 3,
  /** Probe tap junctioned onto nextPc. Same net. */
  nextPcTap: 4,
  bus: 5,
  /** Gate output wires: indices 6..29 (gate i at 6 + i). */
  gateOut: 6,
} as const;
