import { describe, expect, it } from "vitest";
import { SimController, formatValue } from "./controller";
import { createMockCore } from "../ipc/mock";
import { buildMockDemoDoc } from "../editor/mockDemoCircuit";
import { MOCK_DEMO_COMPS } from "../ipc/mockDemoSpec";

/** Synchronous flush: diffs apply immediately (no rAF in tests). */
function makeController() {
  const core = createMockCore();
  return new SimController(core, (cb) => cb());
}

describe("SimController", () => {
  it("loads a document: net map inverted, named comps stored", async () => {
    const ctl = makeController();
    const ok = await ctl.load(buildMockDemoDoc());
    expect(ok).toBe(true);
    expect(ctl.store.loaded).toBe(true);
    expect(ctl.store.wireToNet?.size).toBe(buildMockDemoDoc().circuit(0).wires.length);
    expect(ctl.store.named.map((n) => n.name)).toEqual(["pc", "next_pc", "imem"]);
  });

  it("watch values track the simulation (register q, probe in)", async () => {
    const ctl = makeController();
    await ctl.load(buildMockDemoDoc());
    const [pc, nextPc] = ctl.store.named;
    expect(ctl.watchValue(pc)).toEqual({ v: "00000000", x: "00000000", z: "00000000" });
    expect(ctl.watchValue(nextPc)).toEqual({ v: "00000001", x: "00000000", z: "00000000" });
    await ctl.stepTick(); // posedge: pc latches 1
    expect(Number(BigInt(`0x${ctl.watchValue(pc)!.v}`))).toBe(1);
    expect(Number(BigInt(`0x${ctl.watchValue(nextPc)!.v}`))).toBe(2);
  });

  it("unwired named comps (ram imem) have no watch value", async () => {
    const ctl = makeController();
    await ctl.load(buildMockDemoDoc());
    const imem = ctl.store.named.find((n) => n.kind === "ram")!;
    expect(ctl.watchValue(imem)).toBeUndefined();
  });

  it("haltHighlight resolves the offending component from details", async () => {
    const ctl = makeController();
    await ctl.load(buildMockDemoDoc());
    expect(ctl.haltHighlight()).toBeNull();
    await ctl.poke(MOCK_DEMO_COMPS.buffer, "consume", { v: "0", x: "0", z: "0" });
    expect(ctl.store.halted?.reason).toBe("floating-read");
    expect(ctl.haltHighlight()).toBe(MOCK_DEMO_COMPS.buffer);
  });

  it("unload returns the store to pre-load state", async () => {
    const ctl = makeController();
    await ctl.load(buildMockDemoDoc());
    ctl.unload();
    expect(ctl.store.loaded).toBe(false);
    expect(ctl.store.netValues.size).toBe(0);
    expect(ctl.watchValue({ name: "pc", kind: "register", comp_id: 1 })).toBeUndefined();
  });
});

describe("formatValue", () => {
  it("hex / unsigned / signed", () => {
    const v = { v: "fffffffe", x: "00000000", z: "00000000" };
    expect(formatValue(v, "hex")).toBe("0xfffffffe");
    expect(formatValue(v, "unsigned")).toBe("4294967294");
    expect(formatValue(v, "signed")).toBe("-2");
  });

  it("X dominates; all-Z shows Z; unknown shows —", () => {
    expect(formatValue({ v: "0f", x: "f0", z: "00" }, "hex")).toBe("X");
    expect(formatValue({ v: "00", x: "00", z: "ff" }, "unsigned")).toBe("Z");
    expect(formatValue(undefined, "hex")).toBe("—");
  });
});
