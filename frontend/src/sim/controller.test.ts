import { describe, expect, it } from "vitest";
import { SimController, formatValue } from "./controller";
import { createMockCore } from "../ipc/mock";
import { buildMockDemoDoc } from "../editor/mockDemoCircuit";
import { MOCK_DEMO_COMPS } from "../ipc/mockDemoSpec";
import { CircuitDocument } from "../model/document";

/** Synchronous flush: diffs apply immediately (no rAF in tests). */
function makeController() {
  const core = createMockCore();
  return new SimController(core, (cb) => cb());
}

describe("SimController", () => {
  it("re-syncs a FILE-backed document from the editor's text, at its path (§100)", async () => {
    // Re-reading the file picked up a stale copy autosave had not rewritten
    // yet, so a fixed load error stayed on screen in the desktop app.
    const core = createMockCore();
    const realLoad = core.api.loadCircuit.bind(core.api);
    const calls: { path?: string; text?: string }[] = [];
    let current = "";
    core.api.loadCircuit = async (src) => {
      calls.push({
        path: src.path,
        text: src.bytes === undefined ? undefined : new TextDecoder().decode(src.bytes),
      });
      // A path-only load reads "the file" — which is whatever it was at open.
      return realLoad({ bytes: src.bytes ?? new TextEncoder().encode(current) });
    };
    const ctl = new SimController(core, (cb) => cb());
    const doc = buildMockDemoDoc();
    current = doc.toJson();
    expect(await ctl.loadFromPath(doc, "/work/cpu.csx")).toBe(true);
    expect(calls[0]).toEqual({ path: "/work/cpu.csx", text: undefined }); // Open reads the file

    // An edit the file does not have yet: the re-sync sends the EDITOR's text.
    doc.updateComponent(0, doc.circuit(0).components[0].id, { name: "renamed" });
    expect(await ctl.resync(doc)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].path).toBe("/work/cpu.csx"); // autoloads still resolve there
    expect(calls[1].text).toBe(doc.toJson());
  });

  it("retries a FAILED load once the document changes, so a fixed error clears (§99)", async () => {
    // The engine refuses an unnamed pin; this core refuses until the pin has a name.
    const core = createMockCore();
    const realLoad = core.api.loadCircuit.bind(core.api);
    core.api.loadCircuit = async (src) => {
      const parsed = JSON.parse(new TextDecoder().decode(src.bytes)) as {
        circuits: { components: { type: string; name?: string }[] }[];
      };
      const unnamed = parsed.circuits.some((c) =>
        c.components.some((x) => x.type === "wiring.pin" && (x.name ?? "") === ""),
      );
      if (unnamed) {
        return {
          ok: false,
          errors: [{ kind: "other", message: "wiring.pin components must be named", circuit: "t" }],
          net_map: [],
          named: [],
        };
      }
      return realLoad(src);
    };
    const ctl = new SimController(core, (cb) => cb());
    const doc = CircuitDocument.create("t");
    const id = doc.addComponent(0, { type: "wiring.pin", pos: [0, 0], name: "a" });
    doc.updateComponent(0, id, { name: "" }); // the broken state the banner reported
    expect(await ctl.load(doc)).toBe(false);
    expect(ctl.store.loadErrors).toHaveLength(1);
    // Nothing changed yet: retrying the same netlist would fail the same way.
    expect(ctl.needsRetry(doc)).toBe(false);
    // Naming the pin is a netlist change: a retry is due, and it clears the error.
    doc.updateComponent(0, id, { name: "a" });
    expect(ctl.needsRetry(doc)).toBe(true);
    expect(await ctl.resync(doc)).toBe(true);
    expect(ctl.store.loadErrors).toHaveLength(0);
    expect(ctl.needsRetry(doc)).toBe(false);
  });

  it("loads a document: net map inverted, named comps stored", async () => {
    const ctl = makeController();
    const ok = await ctl.load(buildMockDemoDoc());
    expect(ok).toBe(true);
    expect(ctl.store.loaded).toBe(true);
    expect(ctl.store.wireToNet?.size).toBe(buildMockDemoDoc().circuit(0).wires.length);
    expect(ctl.store.named.map((n) => n.name)).toEqual(["pc", "next_pc", "imem"]);
  });

  it("resync reloads on netlist edits, not on geometry-only edits", async () => {
    const ctl = makeController();
    const doc = buildMockDemoDoc();

    // Nothing loaded yet → the first command loads the current document.
    expect(ctl.isStale(doc)).toBe(false);
    expect(await ctl.resync(doc)).toBe(true);
    expect(ctl.store.loaded).toBe(true);
    expect(ctl.isStale(doc)).toBe(false);

    // Unchanged document → no reload, so live sim state is preserved.
    await ctl.stepTick();
    await ctl.stepTick();
    const cycle = ctl.store.cycle;
    expect(cycle).toBeGreaterThan(0);
    expect(await ctl.resync(doc)).toBe(true);
    expect(ctl.store.cycle).toBe(cycle);

    // Moving a part changes only geometry → still current, so the loaded sim
    // (and its cycle counter) survives. An edit must not look like a reset.
    const id = doc.circuit(0).components[0].id;
    doc.moveComponent(0, id, { x: 2, y: 2 });
    expect(ctl.isStale(doc)).toBe(false);
    expect(await ctl.resync(doc)).toBe(true);
    expect(ctl.store.cycle).toBe(cycle);

    // A real netlist edit → stale; the next command reloads a fresh power-on.
    doc.addComponent(0, { type: "wiring.constant", pos: [0, 0], attrs: { value: "1" } });
    expect(ctl.isStale(doc)).toBe(true);
    expect(await ctl.resync(doc)).toBe(true);
    expect(ctl.isStale(doc)).toBe(false);
    expect(ctl.store.cycle).toBe(0);
    expect(ctl.store.loaded).toBe(true);
  });

  it("reads a named component through its value_net, even with the value pin unwired", () => {
    const ctl = makeController();
    // A register whose `q` is unwired has NO wire→net entry at all — only the
    // engine's value_net (contract v1.2). That is how the readout survives an
    // open output instead of falling back to a zero placeholder.
    ctl.store.onLoaded(new Map(), [
      { name: "r", kind: "register", comp_id: 0, circuit: "main", value_net: 7 },
    ]);
    ctl.store.applyDiffs(new Map([[7, { val: { v: "5", x: "", z: "" } }]]), 1, true);
    expect(ctl.watchValue(ctl.store.named[0])).toMatchObject({ v: "5" });
  });

  it("serializes loads so an in-flight one cannot clobber a newer one", async () => {
    const core = createMockCore();
    let inFlight = 0;
    let maxInFlight = 0;
    const real = core.api.loadCircuit.bind(core.api);
    core.api.loadCircuit = async (src) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return real(src);
    };
    const ctl = new SimController(core, (cb) => cb());
    const doc = buildMockDemoDoc();
    const [a, b] = await Promise.all([ctl.load(doc), ctl.load(doc)]);
    expect([a, b]).toEqual([true, true]);
    expect(maxInFlight).toBe(1); // the two loads never overlapped
    expect(ctl.store.loaded).toBe(true);
  });

  it("remembers a poked register value until the next command", async () => {
    const ctl = makeController();
    await ctl.load(buildMockDemoDoc());
    ctl.rememberPokedRegister("c1", "5");
    expect(ctl.pokedRegister("c1")).toBe("5");
    await ctl.stepTick(); // a command supersedes the optimistic value
    expect(ctl.pokedRegister("c1")).toBeUndefined();
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
    // The run only stops on a floating read when the preference asks (contract v1.4), so
    // this needs the core handle the helper otherwise hides.
    const core = createMockCore();
    const ctl = new SimController(core, (cb) => cb());
    await ctl.load(buildMockDemoDoc());
    expect(ctl.haltHighlight()).toBeNull();
    await core.api.setPauseOnUnknown(true);
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
    expect(
      ctl.watchValue({ name: "pc", kind: "register", comp_id: 1, circuit: "main" }),
    ).toBeUndefined();
  });

  it("the initial full-state batch paints values but spawns no pulses (v1.1)", async () => {
    const ctl = makeController();
    await ctl.load(buildMockDemoDoc());
    expect(ctl.store.netValues.size).toBeGreaterThan(0); // painted
    expect(ctl.store.lastChanged).toEqual([]); // but nothing "changed"
    await ctl.stepTick();
    expect(ctl.store.lastChanged.length).toBeGreaterThan(0); // real changes do
    // Delay mode: changes carry engine event times for the pulses.
    expect(ctl.store.lastChanged.every((e) => e.at !== undefined)).toBe(true);
  });

  it("topPathIds drops entries for other circuits (v1.1 filter)", async () => {
    const ctl = makeController();
    await ctl.load(buildMockDemoDoc());
    await ctl.runUntil(3);
    expect(ctl.topPathIds()).toHaveLength(3); // demo sheet matches
    expect(typeof ctl.topPathDelay()).toBe("number"); // …and its observed ns (§74)
    // Rewrite the timing event as belonging to a different circuit.
    const foreign = ctl.store.timing!;
    ctl.store.onTiming({
      ...foreign,
      top_paths: [{ circuit: "alu", comps: [0, 1], delay_ns: 9 }],
    });
    expect(ctl.topPathIds()).toBeNull(); // filtered out
    expect(ctl.topPathDelay()).toBeNull(); // …delay too (same sheet filter)
  });
});

describe("formatValue", () => {
  it("hex / unsigned / signed / bin", () => {
    const v = { v: "fffffffe", x: "00000000", z: "00000000" };
    expect(formatValue(v, "hex")).toBe("0xfffffffe");
    expect(formatValue(v, "unsigned")).toBe("4294967294");
    expect(formatValue(v, "signed")).toBe("-2");
    expect(formatValue({ v: "a", x: "00", z: "00" }, "bin")).toBe("0b1010");
  });

  it("X dominates; all-Z shows Z; unknown shows —", () => {
    expect(formatValue({ v: "0f", x: "f0", z: "00" }, "hex")).toBe("X");
    expect(formatValue({ v: "00", x: "00", z: "ff" }, "unsigned")).toBe("Z");
    expect(formatValue(undefined, "hex")).toBe("—");
  });
});
