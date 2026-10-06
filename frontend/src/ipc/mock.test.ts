import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcEvents } from "./types";
import type { NetDiffs, SimHalted, SimStatus, TimingUpdate, WireValue } from "./types";
import { createMockCore, MOCK_COMP, MOCK_GATE_COUNT, MOCK_NET } from "./mock";
import { getCore } from "./index";

type Mock = ReturnType<typeof createMockCore>;

function lastVal(diffs: NetDiffs[], net: number): WireValue | undefined {
  for (let i = diffs.length - 1; i >= 0; i--) {
    const change = diffs[i].changes.find((c) => c.net === net);
    if (change) return change.val;
  }
  return undefined;
}

describe("mock core (U9)", () => {
  let mock: Mock;
  let diffs: NetDiffs[];
  let statuses: SimStatus[];
  let halts: SimHalted[];
  let timings: TimingUpdate[];

  beforeEach(async () => {
    vi.useFakeTimers();
    mock = createMockCore();
    diffs = [];
    statuses = [];
    halts = [];
    timings = [];
    mock.events.on(IpcEvents.NetDiffs, (p) => diffs.push(p));
    mock.events.on(IpcEvents.SimStatus, (p) => statuses.push(p));
    mock.events.on(IpcEvents.SimHalted, (p) => halts.push(p));
    mock.events.on(IpcEvents.TimingUpdate, (p) => timings.push(p));
    await mock.api.loadCircuit({ path: "demo.csx" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("loadCircuit", () => {
    it("returns ok with named components and a net_map covering every net", () => {
      return mock.api.loadCircuit({ path: "demo.csx" }).then((res) => {
        expect(res.ok).toBe(true);
        expect(res.errors).toEqual([]);
        expect(res.named).toEqual([
          { name: "pc", kind: "register", comp_id: MOCK_COMP.pc },
          { name: "next_pc", kind: "probe", comp_id: MOCK_COMP.nextPcProbe },
          { name: "imem", kind: "ram", comp_id: MOCK_COMP.imem },
        ]);
        expect(res.net_map).toHaveLength(4 + MOCK_GATE_COUNT);
      });
    });

    it("requires a path or bytes", async () => {
      await expect(mock.api.loadCircuit({})).rejects.toThrow("path or bytes");
    });

    it("emits an initial full-state batch so the UI can paint", () => {
      expect(diffs).toHaveLength(1);
      expect(diffs[0].cycle).toBe(0);
      const nets = diffs[0].changes.map((c) => c.net);
      expect(nets).toContain(MOCK_NET.clk);
      expect(nets).toContain(MOCK_NET.pcQ);
      expect(nets).toContain(MOCK_NET.nextPc);
      expect(nets).toContain(MOCK_NET.bus);
      expect(nets).toHaveLength(4 + MOCK_GATE_COUNT);
      // clk is low before the first tick, so the demo bus floats.
      expect(lastVal(diffs, MOCK_NET.bus)).toEqual({ v: "00", x: "00", z: "ff" });
    });
  });

  describe("stepping", () => {
    it("stepTick advances a half-cycle: posedge latches the counter", async () => {
      diffs.length = 0;
      await mock.api.stepTick();
      const cycle = Math.max(...diffs.map((d) => d.cycle));
      expect(cycle).toBe(0); // still cycle 0 — a cycle is two ticks
      expect(lastVal(diffs, MOCK_NET.clk)).toEqual({ v: "1", x: "0", z: "0" });
      expect(lastVal(diffs, MOCK_NET.pcQ)).toMatchObject({ v: "00000001" });
      expect(lastVal(diffs, MOCK_NET.nextPc)).toMatchObject({ v: "00000002" });
    });

    it("stepCycles(n) advances exactly n cycles and the counter tracks", async () => {
      diffs.length = 0;
      await mock.api.stepCycles(3);
      expect(Math.max(...diffs.map((d) => d.cycle))).toBe(3);
      expect(lastVal(diffs, MOCK_NET.pcQ)).toMatchObject({ v: "00000003" });
      expect(lastVal(diffs, MOCK_NET.nextPc)).toMatchObject({ v: "00000004" });
      // back to clk low after a whole number of cycles
      expect(lastVal(diffs, MOCK_NET.clk)).toEqual({ v: "0", x: "0", z: "0" });
    });

    it("emits only changed nets", async () => {
      await mock.api.setMode("zero"); // one merged batch per tick
      diffs.length = 0;
      await mock.api.stepTick(); // posedge: everything may change
      await mock.api.stepTick(); // negedge: pc unchanged → only clk + bus change
      const negedgeBatch = diffs[diffs.length - 1];
      expect(negedgeBatch.changes.map((c) => c.net).sort()).toEqual([MOCK_NET.clk, MOCK_NET.bus]);
    });
  });

  describe("delay vs zero mode", () => {
    it("delay mode splits each tick into sequential + combinational batches", async () => {
      diffs.length = 0;
      await mock.api.setMode("delay");
      await mock.api.stepTick(); // posedge: state and comb both change
      expect(diffs).toHaveLength(2);
      expect(diffs[0].changes.map((c) => c.net)).toEqual([MOCK_NET.clk, MOCK_NET.pcQ]);
      expect(diffs[1].changes.map((c) => c.net)).not.toContain(MOCK_NET.clk);
    });

    it("zero mode emits one merged batch per tick", async () => {
      diffs.length = 0;
      await mock.api.setMode("zero");
      await mock.api.stepTick();
      expect(diffs).toHaveLength(1);
      const nets = diffs[0].changes.map((c) => c.net);
      expect(nets).toContain(MOCK_NET.clk);
      expect(nets).toContain(MOCK_NET.nextPc);
    });
  });

  describe("play/pause", () => {
    it("runs at the requested clock rate and reports status", async () => {
      diffs.length = 0;
      await mock.api.play(100); // 100 cycles/s = 200 ticks/s → 5 ms/tick
      expect(statuses.at(-1)).toMatchObject({ running: true, cycle: 0, eff_hz: 100 });

      await vi.advanceTimersByTimeAsync(1000);
      expect(Math.max(...diffs.map((d) => d.cycle))).toBe(100);
      expect(lastVal(diffs, MOCK_NET.pcQ)).toMatchObject({ v: "00000064" }); // 100

      await mock.api.pause();
      expect(statuses.at(-1)).toMatchObject({ running: false, cycle: 100, eff_hz: 0 });
      expect(timings).toHaveLength(1); // contract: timing_update on pause
    });

    it("emits sim_status roughly once per second while running", async () => {
      await mock.api.play(100);
      statuses.length = 0;
      await vi.advanceTimersByTimeAsync(3000);
      expect(statuses).toHaveLength(3);
      expect(statuses[0]).toMatchObject({ running: true, cycle: 100 });
    });

    it("stops emitting when paused", async () => {
      await mock.api.play(100);
      await mock.api.pause();
      diffs.length = 0;
      await vi.advanceTimersByTimeAsync(2000);
      expect(diffs).toHaveLength(0);
    });

    it("high rates burst many cycles per interval (perf-test shape)", async () => {
      diffs.length = 0;
      await mock.api.play(1_000_000);
      await vi.advanceTimersByTimeAsync(4); // one clamped interval
      expect(diffs.length).toBeGreaterThan(1000);
      expect(Math.max(...diffs.map((d) => d.cycle))).toBe(4000);
      await mock.api.pause();
    });
  });

  describe("runUntil", () => {
    it("advances to the target cycle and emits a timing update", async () => {
      await mock.api.runUntil(5);
      expect(timings).toHaveLength(1);
      expect(timings[0]).toEqual({
        t_obs: 42.5,
        est_time: 5 * 42.5,
        violations: 0,
        top_paths: [[MOCK_COMP.pc, MOCK_COMP.adder, MOCK_COMP.pc]],
      });
      expect(lastVal(diffs, MOCK_NET.pcQ)).toMatchObject({ v: "00000005" });
    });

    it("refuses absurd targets instead of hanging", async () => {
      await expect(mock.api.runUntil(100_000_000)).rejects.toThrow("safety cap");
    });
  });

  describe("memory commands", () => {
    it("memWrite then memRead round-trips", async () => {
      const values: WireValue[] = [
        { v: "0000002a", x: "00000000", z: "00000000" },
        { v: "deadbeef", x: "00000000", z: "00000000" },
      ];
      await mock.api.memWrite("imem", 0x10, values);
      await expect(mock.api.memRead("imem", 0x10, 2)).resolves.toEqual(values);
    });

    it("rejects unknown memory names and out-of-range addresses", async () => {
      await expect(mock.api.memRead("dmem", 0, 1)).rejects.toThrow('no memory named "dmem"');
      await expect(mock.api.memRead("imem", 255, 2)).rejects.toThrow("out of range");
    });
  });

  describe("poke", () => {
    it("forcing the register updates dependent nets immediately", async () => {
      diffs.length = 0;
      await mock.api.poke(MOCK_COMP.pc, "q", { v: "00000040", x: "00000000", z: "00000000" });
      expect(lastVal(diffs, MOCK_NET.pcQ)).toMatchObject({ v: "00000040" });
      expect(lastVal(diffs, MOCK_NET.nextPc)).toMatchObject({ v: "00000041" });
    });

    it("forcing the bus drives the x/z masks through (X rendering demo)", async () => {
      diffs.length = 0;
      await mock.api.poke(MOCK_COMP.buffer, "force", { v: "0f", x: "f0", z: "00" });
      expect(lastVal(diffs, MOCK_NET.bus)).toEqual({ v: "0f", x: "f0", z: "00" });
      await mock.api.poke(MOCK_COMP.buffer, "unforce", { v: "00", x: "00", z: "00" });
      expect(lastVal(diffs, MOCK_NET.bus)).toEqual({ v: "00", x: "00", z: "ff" });
    });

    it("consuming the bus while it floats halts with floating-read (§4.1)", async () => {
      // clk is low after load → bus is Z.
      await mock.api.poke(MOCK_COMP.buffer, "consume", { v: "0", x: "0", z: "0" });
      expect(halts).toHaveLength(1);
      expect(halts[0]).toMatchObject({ cycle: 0, reason: "floating-read" });
      expect(halts[0].details).toContain(`comp ${MOCK_COMP.buffer}`);
    });

    it("consuming the bus while driven does not halt", async () => {
      await mock.api.stepTick(); // posedge: clk high → bus driven
      await mock.api.poke(MOCK_COMP.buffer, "consume", { v: "0", x: "0", z: "0" });
      expect(halts).toHaveLength(0);
    });

    it("rejects unknown pokes", async () => {
      await expect(mock.api.poke(999, "q", { v: "0", x: "0", z: "0" })).rejects.toThrow(
        "no pinnable",
      );
    });
  });

  describe("snapshot/resume", () => {
    it("resume restores state and the run repeats deterministically", async () => {
      await mock.api.stepCycles(5);
      const atFive = lastVal(diffs, MOCK_NET.pcQ);
      await mock.api.snapshot("slot-a");
      await mock.api.stepCycles(3);
      await mock.api.resume("slot-a");
      expect(statuses.at(-1)).toMatchObject({ cycle: 5 });
      expect(lastVal(diffs, MOCK_NET.pcQ)).toEqual(atFive);

      diffs.length = 0;
      await mock.api.stepCycles(3);
      expect(lastVal(diffs, MOCK_NET.pcQ)).toMatchObject({ v: "00000008" });
    });

    it("resume of an unknown path rejects", async () => {
      await expect(mock.api.resume("nope")).rejects.toThrow("no snapshot");
    });
  });

  describe("saveCircuit", () => {
    it("reports ok and records the document", async () => {
      const doc = { format: "circuitsim-plus-plus", version: 2 };
      await expect(mock.api.saveCircuit("/tmp/a.csx", doc)).resolves.toEqual({
        ok: true,
        errors: [],
      });
      expect(mock.api.lastSave).toEqual({ path: "/tmp/a.csx", document: doc });
    });
  });
});

describe("getCore (selection seam)", () => {
  it("returns the mock when VITE_MOCK_CORE=1", () => {
    vi.stubEnv("VITE_MOCK_CORE", "1");
    const core = getCore();
    expect(core.api).toBeDefined();
    expect(core.events).toBeDefined();
    expect(getCore()).toBe(core); // shared app-session instance
  });

  it("throws a clear error without the mock until U5 lands", () => {
    vi.stubEnv("VITE_MOCK_CORE", "");
    expect(() => getCore()).toThrow("U5");
  });
});
