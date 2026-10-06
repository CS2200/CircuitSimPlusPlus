/**
 * Document-driven mock loading (U5): when loadCircuit receives real .csx
 * bytes, the mock derives nets from the document itself — demo circuit
 * (mockDemoSpec) gets the counter behavior, anything else loads
 * structurally with all nets floating.
 */

import { describe, expect, it } from "vitest";
import { createMockCore } from "./mock";
import { IpcEvents, type NetDiffs, type SimHalted, type TimingUpdate } from "./types";
import { buildMockDemoDoc } from "../editor/mockDemoCircuit";
import { buildDemoDoc } from "../editor/demoCircuit";
import { MOCK_DEMO_CIRCUIT, MOCK_DEMO_COMPS } from "./mockDemoSpec";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Collect net_diffs emitted between subscribe and unsubscribe. */
function collectDiffs(core: ReturnType<typeof createMockCore>): NetDiffs[] {
  const batches: NetDiffs[] = [];
  core.events.on(IpcEvents.NetDiffs, (d) => batches.push(d));
  return batches;
}

describe("mock core: demo document mode (U5)", () => {
  async function loadDemo() {
    const core = createMockCore();
    const batches = collectDiffs(core);
    const res = await core.api.loadCircuit({ bytes: bytesOf(buildMockDemoDoc().toJson()) });
    return { core, batches, res };
  }

  it("derives the net_map from the document, covering every wire", async () => {
    const { res } = await loadDemo();
    expect(res.ok).toBe(true);
    const doc = buildMockDemoDoc();
    const wireCount = doc.circuit(0).wires.length;
    const covered = res.net_map.flatMap((e) => e.wires).sort((a, b) => a - b);
    expect(covered).toEqual(Array.from({ length: wireCount }, (_, i) => i));
    // Junctions and fan-out merge wires into shared nets: fewer nets than wires.
    expect(res.net_map.length).toBeLessThan(wireCount);
  });

  it("reports named components by component-array index (CompId convention)", async () => {
    const { res } = await loadDemo();
    expect(res.named).toEqual([
      { name: "pc", kind: "register", comp_id: MOCK_DEMO_COMPS.pc, circuit: MOCK_DEMO_CIRCUIT },
      {
        name: "next_pc",
        kind: "probe",
        comp_id: MOCK_DEMO_COMPS.nextPcProbe,
        circuit: MOCK_DEMO_CIRCUIT,
      },
      { name: "imem", kind: "ram", comp_id: MOCK_DEMO_COMPS.imem, circuit: MOCK_DEMO_CIRCUIT },
    ]);
  });

  it("timing messages name the document's own circuit (v1.1)", async () => {
    const { core } = await loadDemo();
    const timings: TimingUpdate[] = [];
    core.events.on(IpcEvents.TimingUpdate, (t) => timings.push(t));
    await core.api.runUntil(2);
    expect(timings).toHaveLength(1);
    expect(timings[0].violations).toEqual([
      {
        circuit: MOCK_DEMO_CIRCUIT,
        comp_id: MOCK_DEMO_COMPS.pc,
        kind: "setup",
        detail: expect.stringContaining("t_setup"),
      },
    ]);
    expect(timings[0].top_paths).toEqual([
      {
        circuit: MOCK_DEMO_CIRCUIT,
        comps: [MOCK_DEMO_COMPS.pc, MOCK_DEMO_COMPS.adder, MOCK_DEMO_COMPS.pc],
        delay_ns: 42.5,
      },
    ]);
  });

  it("paints initial state and animates: clk, pc counter, floating bus", async () => {
    const { core, batches, res } = await loadDemo();
    expect(batches).toHaveLength(1); // initial full-state
    expect(batches[0].full).toBe(true); // v1.1: THE one full batch
    const initial = new Map(batches[0].changes.map((c) => [c.net, c.val]));
    const netOfWire = (w: number) => res.net_map.find((e) => e.wires.includes(w))!.net;
    const clk = netOfWire(0);
    const pcQ = netOfWire(1);
    const bus = netOfWire(5);
    expect(initial.get(clk)).toEqual({ v: "0", x: "0", z: "0" });
    expect(initial.get(pcQ)!.z).toBe("00000000");
    expect(initial.get(bus)).toEqual({ v: "00", x: "00", z: "ff" }); // floats while clk low

    batches.length = 0;
    await core.api.stepTick(); // posedge: clk rises, pc latches 1
    const changed = new Map(batches.flatMap((b) => b.changes).map((c) => [c.net, c.val]));
    expect(changed.get(clk)).toEqual({ v: "1", x: "0", z: "0" });
    expect(Number(BigInt(`0x${changed.get(pcQ)!.v}`))).toBe(1);
    expect(changed.get(bus)).toEqual({ v: "01", x: "00", z: "00" }); // driven while clk high
  });

  it("poke targets follow the document's comp indices", async () => {
    const { core, batches, res } = await loadDemo();
    batches.length = 0;
    await core.api.poke(MOCK_DEMO_COMPS.pc, "q", { v: "2a", x: "0", z: "0" });
    const pcQ = res.net_map.find((e) => e.wires.includes(1))!.net;
    const changed = new Map(batches.flatMap((b) => b.changes).map((c) => [c.net, c.val]));
    expect(Number(BigInt(`0x${changed.get(pcQ)!.v}`))).toBe(42);
  });

  it("consuming the floating bus halts, naming the document's buffer comp", async () => {
    const { core } = await loadDemo();
    const halts: SimHalted[] = [];
    core.events.on(IpcEvents.SimHalted, (h) => halts.push(h));
    await core.api.poke(MOCK_DEMO_COMPS.buffer, "consume", { v: "0", x: "0", z: "0" });
    expect(halts).toHaveLength(1);
    expect(halts[0].reason).toBe("floating-read");
    expect(halts[0].details).toContain(`comp ${MOCK_DEMO_COMPS.buffer}`);
  });
});

describe("mock core: memory autoload (U6)", () => {
  function docWithAutoload(autoload: string) {
    const doc = buildMockDemoDoc();
    doc.updateComponent(0, "c5", { attrs: { autoload } }); // c5 = imem
    return doc;
  }

  it("seeds the memory from the inline-hex image at load", async () => {
    const core = createMockCore();
    await core.api.loadCircuit({ bytes: bytesOf(docWithAutoload("hex:0a ff 3-00 2a").toJson()) });
    const words = await core.api.memRead("imem", 0, 6);
    expect(words.map((w) => Number(BigInt(`0x${w.v}`)))).toEqual([0x0a, 0xff, 0, 0, 0, 0x2a]);
  });

  it("reset (re-load) restores the image after memWrite (§5.2)", async () => {
    const core = createMockCore();
    const doc = docWithAutoload("hex:01 02");
    await core.api.loadCircuit({ bytes: bytesOf(doc.toJson()) });
    await core.api.memWrite("imem", 0, [{ v: "dead", x: "", z: "" }]);
    expect((await core.api.memRead("imem", 0, 1))[0].v).toBe("0000dead");
    // reset = load again: the autoload image re-applies
    await core.api.loadCircuit({ bytes: bytesOf(doc.toJson()) });
    const words = await core.api.memRead("imem", 0, 2);
    expect(words.map((w) => Number(BigInt(`0x${w.v}`)))).toEqual([1, 2]);
  });

  it("a plain (non-inline-hex) path yields an empty image", async () => {
    const core = createMockCore();
    await core.api.loadCircuit({ bytes: bytesOf(docWithAutoload("program.hex").toJson()) });
    const words = await core.api.memRead("imem", 0, 4);
    expect(words.every((w) => w.v === "00000000")).toBe(true);
  });
});

describe("mock core: generic document mode (U5)", () => {
  it("loads any document structurally; every net floats, no behavior", async () => {
    const core = createMockCore();
    const batches = collectDiffs(core);
    const doc = buildDemoDoc(); // the U4 visual showcase — not the mock circuit
    const res = await core.api.loadCircuit({ bytes: bytesOf(doc.toJson()) });
    expect(res.ok).toBe(true);
    expect(res.named.map((n) => n.name).sort()).toEqual(["acc", "acc_tap", "sum"]);
    expect(res.net_map.flatMap((e) => e.wires)).toHaveLength(doc.circuit(0).wires.length);

    // Initial paint: every net Z. Stepping changes nothing.
    expect(batches).toHaveLength(1);
    expect(batches[0].changes.every((c) => c.val.z !== "0" && c.val.z !== "")).toBe(true);
    batches.length = 0;
    await core.api.stepCycles(4);
    expect(batches).toHaveLength(0);
    await expect(core.api.poke(0, "q", { v: "0", x: "0", z: "0" })).rejects.toThrow("no pinnable");
  });
});
