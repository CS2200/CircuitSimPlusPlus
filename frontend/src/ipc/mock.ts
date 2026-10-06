/**
 * U9 — Mock core: an in-process, deterministic stand-in for csim-core behind
 * the pinned IPC contract (docs/tasks/README.md §3, docs/ipc.md).
 *
 * Exists so U1–U6 can be built and perf-tested without the Rust engine; U5
 * swaps it for the real Tauri adapter behind the same `CoreApi` + `CoreEvents`
 * seams (see index.ts). Enable with `VITE_MOCK_CORE=1`.
 *
 * Demo circuit — a counter (per FRONTEND.md U9):
 *
 *   clock (1) ──▶ register "pc" (2, 32-bit) ──q──▶ adder (3, +1) ──▶ probe "next_pc" (4)
 *                      ▲─────────────d───────────────┘
 *   pc.q also feeds a bank of 24 one-bit gates (ids 10..33) for wire traffic,
 *   and a controlled buffer (6) drives an 8-bit demo bus that floats (Z)
 *   while clk is low. RAM "imem" (5) is 256×32 for mem_read/mem_write.
 *
 * Timing model: a *tick* is one clock half-period; odd ticks are posedges
 * (clk rises, pc latches), even ticks fall. cycle = tick / 2. In "delay" mode
 * each tick emits two `net_diffs` batches (state elements settle, then the
 * combinational cloud — like the real engine's clk→Q propagation); "zero"
 * mode emits one merged batch per tick.
 *
 * Poke affordances for UI development:
 *  - poke(MOCK_COMP.pc, "q", value)        force the register's state
 *  - poke(MOCK_COMP.buffer, "force", v)    force the demo bus (x-mask → X demo)
 *  - poke(MOCK_COMP.buffer, "unforce", _)  release the bus
 *  - poke(MOCK_COMP.buffer, "consume", _)  read the bus; halts with
 *     "floating-read" if it is Z (DESIGN.md §4.1 halt-on-consume)
 *
 * Determinism: no wall-clock reads, no RNG — identical command sequences
 * always produce identical event streams (DESIGN.md §4.6).
 */

import { CoreEventEmitter } from "./events";
import { IpcEvents } from "./types";
import type { CompId, CoreApi, LoadResult, SaveResult, SimMode, WireValue } from "./types";

/** Component IDs of the demo circuit. */
export const MOCK_COMP = {
  clock: 1,
  pc: 2,
  adder: 3,
  nextPcProbe: 4,
  imem: 5,
  buffer: 6,
  /** Gate bank: ids 10..33. */
  gateBase: 10,
} as const;

/** Net IDs of the demo circuit. */
export const MOCK_NET = {
  clk: 0,
  pcQ: 1,
  nextPc: 2,
  bus: 3,
  /** Gate bank: nets 10..33. */
  gateBase: 10,
} as const;

export const MOCK_GATE_COUNT = 24;

const IMEM_WORDS = 256;
/** Plausible 74LS-ish observed critical path (ns); feeds `timing_update`. */
const MOCK_T_OBS_NS = 42.5;
/** setInterval clamps at ~4 ms in practice; don't schedule tighter than that. */
const MIN_PERIOD_MS = 4;
/** Safety valve so a fat-fingered run_until can't hang the dev session. */
const MAX_RUN_UNTIL_CYCLES = 10_000_000;

// ---- value encoding helpers (contract: docs/ipc.md §1) ----

function u32(n: number): WireValue {
  return { v: (n >>> 0).toString(16).padStart(8, "0"), x: "00000000", z: "00000000" };
}

function bit(b: boolean): WireValue {
  return { v: b ? "1" : "0", x: "0", z: "0" };
}

function byte(n: number): WireValue {
  return { v: (n & 0xff).toString(16).padStart(2, "0"), x: "00", z: "00" };
}

/** The 8-bit demo bus undriven. */
const Z_BUS: WireValue = { v: "00", x: "00", z: "ff" };

function sameValue(a: WireValue, b: WireValue): boolean {
  return a.v === b.v && a.x === b.x && a.z === b.z;
}

/** Deterministic 1-bit function of pc for gate-bank net i (traffic for the renderer). */
function gateOutput(i: number, pc: number): boolean {
  const a = (pc >>> (i % 32)) & 1;
  const b = (pc >>> ((i * 7 + 3) % 32)) & 1;
  switch (i % 3) {
    case 0:
      return (a & b) === 1;
    case 1:
      return (a | b) === 1;
    default:
      return (a ^ b) === 1;
  }
}

function valueToU32(val: WireValue): number {
  return Number(BigInt(`0x${val.v || "0"}`)) >>> 0;
}

export class MockCore implements CoreApi {
  readonly events = new CoreEventEmitter();

  private mode: SimMode = "delay";
  private tick = 0;
  private pc = 0;
  private clk = false;
  private busForced: WireValue | null = null;
  private readonly imem = new Uint32Array(IMEM_WORDS);
  private readonly snapshots = new Map<string, string>();
  /** Last emitted value per net — diffs are computed against this. */
  private nets = new Map<number, WireValue>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticksPerInterval = 1;
  private statusEvery = 1;
  private intervalCount = 0;
  private effHz = 0;
  /** Test hook: last document passed to saveCircuit. */
  lastSave: { path: string; document: unknown } | null = null;

  private get cycle(): number {
    return this.tick >> 1;
  }

  // ---- document lifecycle ----

  async loadCircuit(src: { path?: string; bytes?: Uint8Array }): Promise<LoadResult> {
    if (src.path === undefined && src.bytes === undefined) {
      throw new Error("mock load_circuit: a path or bytes is required");
    }
    this.stopTimer();
    this.tick = 0;
    this.pc = 0;
    this.clk = false;
    this.busForced = null;
    this.imem.fill(0);
    this.emitFullState(); // initial paint: one batch with every net

    return {
      ok: true,
      errors: [],
      net_map: [
        { net: MOCK_NET.clk, wires: [0] },
        { net: MOCK_NET.pcQ, wires: [1, 2] }, // fan-out: adder input + gate bank
        { net: MOCK_NET.nextPc, wires: [3] },
        { net: MOCK_NET.bus, wires: [4] },
        ...Array.from({ length: MOCK_GATE_COUNT }, (_, i) => ({
          net: MOCK_NET.gateBase + i,
          wires: [MOCK_NET.gateBase + i],
        })),
      ],
      named: [
        { name: "pc", kind: "register", comp_id: MOCK_COMP.pc },
        { name: "next_pc", kind: "probe", comp_id: MOCK_COMP.nextPcProbe },
        { name: "imem", kind: "ram", comp_id: MOCK_COMP.imem },
      ],
    };
  }

  async saveCircuit(path: string, document: unknown): Promise<SaveResult> {
    this.lastSave = { path, document };
    return { ok: true, errors: [] };
  }

  // ---- simulation control ----

  async play(hz: number): Promise<void> {
    if (this.timer !== null || hz <= 0) return;
    const tickHz = hz * 2; // two ticks per clock cycle
    const periodMs = Math.max(1000 / tickHz, MIN_PERIOD_MS);
    this.ticksPerInterval = Math.max(1, Math.round((tickHz * periodMs) / 1000));
    this.statusEvery = Math.max(1, Math.round(1000 / periodMs));
    this.intervalCount = 0;
    this.effHz = (this.ticksPerInterval * (1000 / periodMs)) / 2;
    this.timer = setInterval(() => {
      for (let i = 0; i < this.ticksPerInterval; i++) this.advanceTick();
      // ~1 Hz status while running, per contract.
      if (++this.intervalCount % this.statusEvery === 0) this.emitStatus();
    }, periodMs);
    this.emitStatus();
  }

  async pause(): Promise<void> {
    this.stopTimer();
    this.emitStatus();
    this.emitTimingUpdate(); // contract: timing_update after sim_run_until / pause
  }

  async stepTick(): Promise<void> {
    this.advanceTick();
  }

  async stepCycles(n: number): Promise<void> {
    for (let i = 0; i < n * 2; i++) this.advanceTick();
  }

  async runUntil(cycle: number): Promise<void> {
    if (cycle - this.cycle > MAX_RUN_UNTIL_CYCLES) {
      throw new Error(`mock run_until: target cycle ${cycle} exceeds safety cap`);
    }
    while (this.cycle < cycle) this.advanceTick();
    this.emitTimingUpdate();
  }

  async setMode(mode: SimMode): Promise<void> {
    this.mode = mode;
    this.emitStatus();
  }

  // ---- inspection & interaction ----

  async poke(compId: CompId, pin: string, value: WireValue): Promise<void> {
    if (compId === MOCK_COMP.pc && pin === "q") {
      this.pc = valueToU32(value);
      this.emitNetDiffs();
      return;
    }
    if (compId === MOCK_COMP.buffer && pin === "force") {
      this.busForced = value;
      this.emitNetDiffs();
      return;
    }
    if (compId === MOCK_COMP.buffer && pin === "unforce") {
      this.busForced = null;
      this.emitNetDiffs();
      return;
    }
    if (compId === MOCK_COMP.buffer && pin === "consume") {
      if (!this.clk && this.busForced === null) {
        // Consuming a floating value halts the simulation (DESIGN.md §4.1).
        this.stopTimer();
        this.events.emit(IpcEvents.SimHalted, {
          cycle: this.cycle,
          reason: "floating-read",
          details: `comp ${MOCK_COMP.buffer} pin "consume": bus is floating (Z)`,
        });
        this.emitStatus();
      }
      return;
    }
    throw new Error(`mock poke: no pinnable "${pin}" on comp ${compId}`);
  }

  async memRead(name: string, addr: number, len: number): Promise<WireValue[]> {
    const mem = this.namedMem(name);
    return Array.from({ length: len }, (_, i) => {
      const a = addr + i;
      if (a < 0 || a >= mem.length) {
        throw new Error(`mock mem_read: ${name} address ${a} out of range`);
      }
      return u32(mem[a]);
    });
  }

  async memWrite(name: string, addr: number, values: WireValue[]): Promise<void> {
    const mem = this.namedMem(name);
    values.forEach((val, i) => {
      const a = addr + i;
      if (a < 0 || a >= mem.length) {
        throw new Error(`mock mem_write: ${name} address ${a} out of range`);
      }
      mem[a] = valueToU32(val);
    });
  }

  private namedMem(name: string): Uint32Array {
    if (name !== "imem") throw new Error(`mock: no memory named "${name}"`);
    return this.imem;
  }

  // ---- snapshots (in-memory; the real engine writes files) ----

  async snapshot(path: string): Promise<void> {
    this.snapshots.set(
      path,
      JSON.stringify({
        tick: this.tick,
        pc: this.pc,
        clk: this.clk,
        imem: Array.from(this.imem),
      }),
    );
  }

  async resume(path: string): Promise<void> {
    const raw = this.snapshots.get(path);
    if (raw === undefined) throw new Error(`mock resume: no snapshot at "${path}"`);
    const s = JSON.parse(raw) as { tick: number; pc: number; clk: boolean; imem: number[] };
    this.stopTimer();
    this.tick = s.tick;
    this.pc = s.pc;
    this.clk = s.clk;
    this.imem.set(s.imem);
    this.emitFullState(); // repaint the restored state
    this.emitStatus();
  }

  // ---- internals ----

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.effHz = 0;
    }
  }

  private currentNets(): Map<number, WireValue> {
    const nets = new Map<number, WireValue>();
    nets.set(MOCK_NET.clk, bit(this.clk));
    nets.set(MOCK_NET.pcQ, u32(this.pc));
    nets.set(MOCK_NET.nextPc, u32((this.pc + 1) >>> 0));
    nets.set(MOCK_NET.bus, this.busForced ?? (this.clk ? byte(this.pc) : Z_BUS));
    for (let i = 0; i < MOCK_GATE_COUNT; i++) {
      nets.set(MOCK_NET.gateBase + i, bit(gateOutput(i, this.pc)));
    }
    return nets;
  }

  /** Emit every net's value in one batch (initial paint / snapshot restore). */
  private emitFullState(): void {
    this.nets = this.currentNets();
    const changes = [...this.nets].map(([net, val]) => ({ net, val }));
    this.events.emit(IpcEvents.NetDiffs, { cycle: this.cycle, changes });
  }

  /** Emit `net_diffs` for every net whose value changed since the last emission. */
  private emitNetDiffs(): void {
    const next = this.currentNets();
    const sequential: { net: number; val: WireValue }[] = [];
    const combinational: { net: number; val: WireValue }[] = [];
    for (const [net, val] of next) {
      const prev = this.nets.get(net);
      if (prev !== undefined && sameValue(prev, val)) continue;
      (net === MOCK_NET.clk || net === MOCK_NET.pcQ ? sequential : combinational).push({
        net,
        val,
      });
    }
    this.nets = next;
    const cycle = this.cycle;
    if (this.mode === "delay" && sequential.length > 0 && combinational.length > 0) {
      this.events.emit(IpcEvents.NetDiffs, { cycle, changes: sequential });
      this.events.emit(IpcEvents.NetDiffs, { cycle, changes: combinational });
    } else if (sequential.length + combinational.length > 0) {
      this.events.emit(IpcEvents.NetDiffs, { cycle, changes: [...sequential, ...combinational] });
    }
  }

  private advanceTick(): void {
    this.tick++;
    if (this.tick % 2 === 1) {
      // posedge: clk rises, pc latches the adder's output (pc + 1)
      this.clk = true;
      this.pc = (this.pc + 1) >>> 0;
    } else {
      this.clk = false;
    }
    this.emitNetDiffs();
  }

  private emitStatus(): void {
    this.events.emit(IpcEvents.SimStatus, {
      running: this.timer !== null,
      cycle: this.cycle,
      mode: this.mode,
      eff_hz: this.effHz,
    });
  }

  private emitTimingUpdate(): void {
    this.events.emit(IpcEvents.TimingUpdate, {
      t_obs: MOCK_T_OBS_NS,
      est_time: this.cycle * MOCK_T_OBS_NS,
      violations: 0,
      top_paths: [[MOCK_COMP.pc, MOCK_COMP.adder, MOCK_COMP.pc]],
    });
  }
}

/** Fresh mock instance (one per app session; tests create their own). */
export function createMockCore(): { api: MockCore; events: CoreEventEmitter } {
  const core = new MockCore();
  return { api: core, events: core.events };
}

/** The shared app-session instance used by `getCore()` in index.ts. */
export const mockCore = createMockCore();
