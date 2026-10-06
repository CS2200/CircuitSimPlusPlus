#!/usr/bin/env python3
"""CPU fixture generator: multicycle.csx and pipeline5.csx (B11).

Both implement the same LC-2200 subset (DESIGN-adjacent, 32-bit,
word-addressed, 16 registers, $0 hardwired to 0):

  [31:29] opcode, [28:25] rd, [24:21] rs, [20:17] rt, [16:0] imm (signed)
    0 add  rd = rs + rt        4 sw   mem[rs+imm] = rd
    1 nand rd = ~(rs & rt)     5 beq  if rs == rt: pc += imm
    2 addi rd = rs + imm       6 halt (PC holds, writes stop)
    3 lw   rd = mem[rs+imm]

The pipeline runs the same program to the same architectural state as
the multicycle; their est_time comparison is the course's lesson
(CPI ~4.5 vs ~1.x). Pipeline hazards are handled by stalling (no
forwarding) — the students' first-pipeline shape.
"""

import json
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "fixtures")
SETTINGS = {"delayModel": "delay", "clockHz": 1, "delayTable": "cs2200-74ls-v1"}

PROGRAM = [
    # 0-2: sum = 0; n = 5; i = 1
    "addi $1,$0,0", "addi $2,$0,5", "addi $3,$0,1",
    # 3: if i == n goto 7
    "beq $3,$2,3",
    # 4-5: sum += i; i++
    "add $1,$1,$3", "addi $3,$3,1",
    # 6: goto 3
    "beq $0,$0,-4",
    # 7-9: dmem[0] = sum; $4 = dmem[0]; $5 = $4 + sum
    "sw $1,0($0)", "lw $4,0($0)", "add $5,$4,$1",
    # 10: halt
    "halt",
]
# Expected architectural state at halt: dmem[0] = 10, $4 = 10, $5 = 20.


def assemble(mnemonic):
    op = mnemonic.split()[0]
    rest = mnemonic.split()[1] if " " in mnemonic else ""
    parts = [p.strip() for p in rest.replace("(", ",").replace(")", "").split(",")] if rest else []

    def reg(s):
        return int(s.lstrip("$"))

    opcode = {"add": 0, "nand": 1, "addi": 2, "lw": 3, "sw": 4, "beq": 5, "halt": 6}[op]
    rd = rs = rt = imm = 0
    if op in ("add", "nand"):
        rd, rs, rt = reg(parts[0]), reg(parts[1]), reg(parts[2])
    elif op == "addi":
        rd, rs, imm = reg(parts[0]), reg(parts[1]), int(parts[2])
    elif op == "lw":  # "lw $rd, off($rs)" -> parts = [rd, off, rs]
        rd, imm, rs = reg(parts[0]), int(parts[1]), reg(parts[2])
    elif op == "sw":  # value register goes in the rt field (datapath reads it)
        rt, imm, rs = reg(parts[0]), int(parts[1]), reg(parts[2])
    elif op == "beq":
        rs, rt, imm = reg(parts[0]), reg(parts[1]), int(parts[2])
    word = (opcode << 29) | (rd << 25) | (rs << 21) | (rt << 17) | (imm & 0x1FFFF)
    return f"{word:08x}"


PROGRAM_HEX = " ".join(assemble(m) for m in PROGRAM)


class Circuit:
    def __init__(self):
        self.components = []
        self.wires = []
        self._ids = {}

    def cid(self, prefix):
        n = self._ids.get(prefix, 0)
        self._ids[prefix] = n + 1
        return f"{prefix}{n}"

    def add(self, type_, id=None, name=None, **attrs):
        cid = id or self.cid(type_.split(".")[-1])
        comp = {"id": cid, "type": type_, "pos": [0, 0]}
        if name:
            comp["name"] = name
        clean = {}
        for k, v in attrs.items():
            if v is not None and not (k == "bitsize" and v == 1):
                clean[k] = v
        if clean:
            comp["attrs"] = clean
        self.components.append(comp)
        return cid

    def wire(self, a_comp, a_pin, b_comp, b_pin):
        self.wires.append({
            "a": {"comp": a_comp, "pin": a_pin},
            "b": {"comp": b_comp, "pin": b_pin},
        })

    def json(self, name):
        return {
            "format": "circuitsim-plus-plus",
            "version": 2,
            "name": name,
            "settings": SETTINGS,
            "circuits": [{"name": "main", "components": self.components, "wires": self.wires}],
        }


class Ctx:
    """Shared datapath helpers: clock/consts and a clocked register."""

    def __init__(self):
        self.c = Circuit()
        self.clk = self.c.add("wiring.clock", id="clk")
        self.one = self._const(1)
        self.zero = self._const(0)

    def _const(self, value, bitsize=1):
        # value attr is a hex mask string.
        return self.c.add("wiring.constant", value=f"{value:x}",
                          bitsize=bitsize if bitsize > 1 else None)

    def const(self, value, bitsize):
        return self._const(value, bitsize)

    def reg(self, name=None, bitsize=32, rst=None, en="tie"):
        """Clocked register. `en`: "tie" -> constant 1; "open" -> caller
        wires it; (comp, pin) -> driven. (Never wire en twice — X!)"""
        r = self.c.add("mem.register", name=name, bitsize=bitsize if bitsize != 1 else None)
        self.c.wire(self.clk, "out", r, "clk")
        if en == "tie":
            self.c.wire(self.one, "out", r, "en")
        elif en == "open":
            pass
        else:
            self.c.wire(en[0], en[1], r, "en")
        self.c.wire(rst if rst else self.zero, "out", r, "rst")
        return r

    def split(self, bus_comp, bus_pin, splits, prefix):
        sp = self.c.add("wiring.splitter", splits=splits)
        self.c.wire(bus_comp, bus_pin, sp, "bus")
        return sp

    def gate(self, op, ins, bitsize=None):
        if len(ins) == 1:
            # 1-input ops: gate.buffer (identity, used as a signal tap).
            g = self.c.add("gate.buffer")
            self.c.wire(ins[0][0], ins[0][1], g, "in")
            return g
        g = self.c.add(f"gate.{op}", inputs=len(ins) if len(ins) > 2 else None,
                       bitsize=bitsize if bitsize and bitsize != 1 else None)
        for i, (comp, pin) in enumerate(ins):
            self.c.wire(comp, pin, g, f"in{i}")
        return g

    def not_(self, comp, pin):
        g = self.c.add("gate.not")
        self.c.wire(comp, pin, g, "in")
        return g


def register_file(ctx, n=16):
    """16 x 32-bit registers ($0 hardwired to 0) with two comb read ports.

    Returns (regs, read_mux(sel4 -> 32) x2 helpers, write_enables list).
    Read port wiring is the caller's job (muxes need select nets).
    """
    c = ctx.c
    regs = []
    for i in range(n):
        r = c.add("mem.register", name=f"r{i}", bitsize=32)
        c.wire(ctx.clk, "out", r, "clk")
        c.wire(ctx.zero, "out", r, "rst")
        # en wired later (write decode); $0 never writes.
        regs.append(r)
    return regs


def read_port(ctx, regs, sel_comp, sel_pin):
    """16:1 32-bit mux reading regs[sel]."""
    mux = ctx.c.add("plexers.mux", bitsize=32, selectBits=4)
    for i, r in enumerate(regs):
        ctx.c.wire(r, "q", mux, f"in{i}")
    ctx.c.wire(sel_comp, sel_pin, mux, "sel")
    return mux


def write_decode(ctx, regs, rd_comp, rd_pin, we_comp, we_pin, data_comp, data_pin):
    """Write `data` into regs[rd] when `we` — with $0 hardwired off."""
    c = ctx.c
    dec = c.add("plexers.decoder", inputBits=4)
    c.wire(rd_comp, rd_pin, dec, "in")
    z32 = ctx.const(0, 32)
    for i, r in enumerate(regs):
        if i == 0:
            c.wire(ctx.zero, "out", r, "en")
            c.wire(z32, "out", r, "d")  # never latches; widths match
            continue
        en = c.add("gate.and")
        c.wire(dec, f"out{i}", en, "in0")
        c.wire(we_comp, we_pin, en, "in1")
        c.wire(en, "out", r, "en")
        c.wire(data_comp, data_pin, r, "d")


def sign_extend(ctx, src_comp, src_pin, in_bits=17, out_bits=32):
    ext = ctx.c.add("arith.bit-extender", inBits=in_bits, outBits=out_bits, mode="sign")
    ctx.c.wire(src_comp, src_pin, ext, "in")
    return ext


def eq32(ctx, a_comp, a_pin, b_comp, b_pin):
    """1 when two 32-bit buses are equal (xor + 32-input NOR)."""
    c = ctx.c
    x = c.add("gate.xor", bitsize=32)
    c.wire(a_comp, a_pin, x, "in0")
    c.wire(b_comp, b_pin, x, "in1")
    sp = c.add("wiring.splitter", splits={f"b{i}": [i] for i in range(32)})
    c.wire(x, "out", sp, "bus")
    nor = c.add("gate.nor", inputs=32)
    for i in range(32):
        c.wire(sp, f"b{i}", nor, f"in{i}")
    return nor


def low_bits(ctx, src_comp, src_pin, nbits, total=32):
    sp = ctx.c.add("wiring.splitter", splits={"lo": list(range(nbits)), "hi": list(range(nbits, total))})
    ctx.c.wire(src_comp, src_pin, sp, "bus")
    return sp


# ---------------------------------------------------------------------------
# Multicycle CPU
# ---------------------------------------------------------------------------
def gen_multicycle():
    ctx = Ctx()
    c = ctx.c

    # -- state elements (en wired by the control section below) --------------
    pc = ctx.reg(name="pc", bitsize=32, en="open")
    ir = ctx.reg(name="ir", bitsize=32, en="open")
    a = ctx.reg(bitsize=32, en="open")
    b = ctx.reg(bitsize=32, en="open")
    aluout = ctx.reg(bitsize=32, en="open")
    mdr = ctx.reg(bitsize=32, en="open")
    state = ctx.reg(name="ustate", bitsize=4)  # always enabled

    # -- memories -----------------------------------------------------------
    imem = c.add("mem.rom", name="imem", bitsize=32, depth=256,
                 autoload="program.hex", contents=PROGRAM_HEX)
    dmem = c.add("mem.ram", name="dmem", bitsize=32, depth=256)
    pc_lo = low_bits(ctx, pc, "q", 8)
    c.wire(pc_lo, "lo", imem, "addr")
    c.wire(imem, "out", ir, "d")
    ao_lo = low_bits(ctx, aluout, "q", 8)
    c.wire(ao_lo, "lo", dmem, "addr")
    c.wire(ctx.clk, "out", dmem, "clk")
    c.wire(dmem, "dout", mdr, "d")

    # -- instruction fields ---------------------------------------------------
    f = ctx.split(ir, "q", {
        "op": [29, 30, 31],
        "rd": [25, 26, 27, 28],
        "rs": [21, 22, 23, 24],
        "rt": [17, 18, 19, 20],
        "imm": list(range(17)),
    }, "f")

    # -- register file --------------------------------------------------------
    regs = register_file(ctx)
    rs_mux = read_port(ctx, regs, f, "rs")
    rt_mux = read_port(ctx, regs, f, "rt")
    c.wire(rs_mux, "out", a, "d")
    c.wire(rt_mux, "out", b, "d")
    wb_mux = c.add("plexers.mux", bitsize=32)
    c.wire(aluout, "q", wb_mux, "in0")
    c.wire(mdr, "q", wb_mux, "in1")
    # wb sel = state 8 (WB_LOAD); wired below with control.
    # write decode: we signal wired below.
    rf_dec = c.add("plexers.decoder", inputBits=4)
    c.wire(f, "rd", rf_dec, "in")

    # -- ALU -------------------------------------------------------------------
    a_mux = c.add("plexers.mux", bitsize=32)
    c.wire(a, "q", a_mux, "in0")
    c.wire(pc, "q", a_mux, "in1")
    b_mux = c.add("plexers.mux", bitsize=32, selectBits=2)
    c.wire(b, "q", b_mux, "in0")
    imm32 = sign_extend(ctx, f, "imm")
    c.wire(imm32, "out", b_mux, "in1")
    c.wire(ctx.const(1, 32), "out", b_mux, "in2")
    c.wire(ctx.const(0, 32), "out", b_mux, "in3")

    adder = c.add("arith.adder", bitsize=32)
    c.wire(a_mux, "out", adder, "a")
    c.wire(b_mux, "out", adder, "b")
    c.wire(ctx.zero, "out", adder, "cin")
    nand = c.add("gate.nand", bitsize=32)
    c.wire(a_mux, "out", nand, "in0")
    c.wire(b_mux, "out", nand, "in1")
    alu_mux = c.add("plexers.mux", bitsize=32)
    c.wire(adder, "out", alu_mux, "in0")
    c.wire(nand, "out", alu_mux, "in1")
    c.wire(alu_mux, "out", aluout, "d")
    c.wire(alu_mux, "out", pc, "d")  # pc always from the live ALU result

    eq = eq32(ctx, a, "q", b, "q")

    # -- control: state decode + opcode decode + next-state -------------------
    sd = c.add("plexers.decoder", inputBits=4)  # state one-hots
    c.wire(state, "q", sd, "in")
    od = c.add("plexers.decoder", inputBits=3)  # opcode one-hots
    c.wire(f, "op", od, "in")
    # dispatch ROM: opcode -> next state from DECODE
    dispatch = c.add("mem.rom", bitsize=4, depth=8,
                     contents="2 2 3 4 4 9 a 0")
    c.wire(f, "op", dispatch, "addr")

    # next-state mux: sel = current state, inputs per state
    nsm = c.add("plexers.mux", bitsize=4, selectBits=4)
    k_dec = ctx.const(1, 4)      # DECODE
    k_fetch = ctx.const(0, 4)    # FETCH
    k_wb = ctx.const(5, 4)       # WB
    k_halt = ctx.const(10, 4)    # HALT
    k_wbload = ctx.const(8, 4)   # WB_LOAD
    # state 4 (EX_ADDR): lw -> 6 (LOAD), sw -> 7 (STORE)
    ls_mux = c.add("plexers.mux", bitsize=4)
    c.wire(ctx.const(7, 4), "out", ls_mux, "in0")
    c.wire(ctx.const(6, 4), "out", ls_mux, "in1")
    c.wire(od, "out3", ls_mux, "sel")  # o_lw
    for k in range(16):
        if k == 0:
            c.wire(k_dec, "out", nsm, "in0")
        elif k == 1:
            c.wire(dispatch, "out", nsm, "in1")
        elif k in (2, 3):
            c.wire(k_wb, "out", nsm, f"in{k}")
        elif k == 4:
            c.wire(ls_mux, "out", nsm, "in4")
        elif k == 6:
            c.wire(k_wbload, "out", nsm, "in6")
        elif k == 10:
            c.wire(k_halt, "out", nsm, "in10")
        else:
            c.wire(k_fetch, "out", nsm, f"in{k}")  # 5,7,8,9 -> FETCH; 11-15 -> 0
    c.wire(state, "q", nsm, "sel")
    c.wire(nsm, "out", state, "d")

    # -- control outputs (Moore) ----------------------------------------------
    def s(k):
        return (sd, f"out{k}")

    ir_we = ctx.gate("buffer", [s(0)])
    c.wire(ir_we, "out", ir, "en")
    # pc_we = s0 | (s9 & eq)
    pc_we = ctx.gate("or", [s(0), (ctx.gate("and", [s(9), (eq, "out")]), "out")])
    c.wire(pc_we, "out", pc, "en")
    ab_we = ctx.gate("buffer", [s(1)])
    c.wire(ab_we, "out", a, "en")
    c.wire(ab_we, "out", b, "en")
    aluout_we = ctx.gate("or", [s(2), s(3), s(4)])
    c.wire(aluout_we, "out", aluout, "en")
    rf_we = ctx.gate("or", [s(5), s(8)])
    for i, r in enumerate(regs):
        if i == 0:
            c.wire(ctx.zero, "out", r, "en")
            c.wire(ctx.const(0, 32), "out", r, "d")  # never latches
            continue
        en = c.add("gate.and")
        c.wire(rf_dec, f"out{i}", en, "in0")
        c.wire(rf_we, "out", en, "in1")
        c.wire(en, "out", r, "en")
        c.wire(wb_mux, "out", r, "d")
    wb_sel = ctx.gate("buffer", [s(8)])
    c.wire(wb_sel, "out", wb_mux, "sel")
    mdr_we = ctx.gate("buffer", [s(6)])
    c.wire(mdr_we, "out", mdr, "en")
    dmem_we = ctx.gate("buffer", [s(7)])
    c.wire(dmem_we, "out", dmem, "we")
    c.wire(b, "q", dmem, "din")
    # alu input selects
    a_sel = ctx.gate("or", [s(0), s(9)])
    c.wire(a_sel, "out", a_mux, "sel")
    b_sel0 = ctx.gate("or", [s(3), s(4), s(9)])  # imm -> sel bit0
    b_sel1 = ctx.gate("buffer", [s(0)])          # const 1 -> sel bit1
    bsel_sp = c.add("wiring.splitter", splits={"b0": [0], "b1": [1]})
    c.wire(bsel_sp, "bus", b_mux, "sel")
    c.wire(b_sel0, "out", bsel_sp, "b0")
    c.wire(b_sel1, "out", bsel_sp, "b1")
    # alu_op: nand when executing a nand R-op
    alu_op = ctx.gate("buffer", [(od, "out1")])
    c.wire(alu_op, "out", alu_mux, "sel")

    # DEBUG
    for nm, comp, pin, bs in [("p_alu", alu_mux, "out", 32), ("p_ns", nsm, "out", 4),
                              ("p_imem", imem, "out", 32), ("p_eq", eq, "out", 1),
                              ("p_pcwe", pc_we, "out", 1), ("p_irwe", ir_we, "out", 1)]:
        c.add("wiring.probe", id=nm, name=nm, bitsize=bs if bs > 1 else None)
        c.wire(comp, pin, nm, "in")

    # -- observable probes -----------------------------------------------------
    c.add("wiring.probe", id="sum", name="sum", bitsize=32)
    c.wire(regs[1], "q", "sum", "in")
    c.add("wiring.probe", id="pc_out", name="pc_out", bitsize=32)
    c.wire(pc, "q", "pc_out", "in")

    doc = ctx.c.json("multicycle")
    return doc


# ---------------------------------------------------------------------------
# Pipeline5: IF/ID/EX/MEM/WB, stall-only hazards (no forwarding — the
# students' first-pipeline shape), beq resolved in EX (2-cycle flush),
# halt = PC stops. Same ISA + same program + same answers as multicycle.
# ---------------------------------------------------------------------------
def gen_pipeline5():
    ctx = Ctx()
    c = ctx.c

    # ---- IF ----------------------------------------------------------------
    pc = ctx.reg(name="pc", bitsize=32, en="open")
    pc_plus1 = c.add("arith.adder", bitsize=32)
    c.wire(pc, "q", pc_plus1, "a")
    c.wire(ctx.const(1, 32), "out", pc_plus1, "b")
    c.wire(ctx.zero, "out", pc_plus1, "cin")
    imem = c.add("mem.rom", name="imem", bitsize=32, depth=256,
                 autoload="program.hex", contents=PROGRAM_HEX)
    pc_lo = low_bits(ctx, pc, "q", 8)
    c.wire(pc_lo, "lo", imem, "addr")

    # ---- IF/ID --------------------------------------------------------------
    ifid_pc1 = ctx.reg(bitsize=32, en="open")
    ifid_ir = ctx.reg(name="ir", bitsize=32, en="open")
    ifid_v = ctx.reg(bitsize=1, en="open")
    c.wire(pc_plus1, "out", ifid_pc1, "d")
    c.wire(imem, "out", ifid_ir, "d")

    # ---- ID: fields, register file, sign extend ------------------------------
    f = ctx.split(ifid_ir, "q", {
        "op": [29, 30, 31],
        "rd": [25, 26, 27, 28],
        "rs": [21, 22, 23, 24],
        "rt": [17, 18, 19, 20],
        "imm": list(range(17)),
    }, "f")
    regs = register_file(ctx)
    rs_mux = read_port(ctx, regs, f, "rs")
    rt_mux = read_port(ctx, regs, f, "rt")
    imm32 = sign_extend(ctx, f, "imm")

    # ---- ID/EX ---------------------------------------------------------------
    idex_a = ctx.reg(bitsize=32, en="tie")
    idex_b = ctx.reg(bitsize=32, en="tie")
    idex_imm = ctx.reg(bitsize=32, en="tie")
    idex_pc1 = ctx.reg(bitsize=32, en="tie")
    idex_op = ctx.reg(bitsize=3, en="tie")
    idex_rd = ctx.reg(bitsize=4, en="tie")
    idex_rs = ctx.reg(bitsize=4, en="tie")
    idex_rt = ctx.reg(bitsize=4, en="tie")
    idex_v = ctx.reg(bitsize=1, en="tie")
    c.wire(rs_mux, "out", idex_a, "d")
    c.wire(rt_mux, "out", idex_b, "d")
    c.wire(imm32, "out", idex_imm, "d")
    c.wire(ifid_pc1, "q", idex_pc1, "d")
    c.wire(f, "op", idex_op, "d")
    c.wire(f, "rd", idex_rd, "d")
    c.wire(f, "rs", idex_rs, "d")
    c.wire(f, "rt", idex_rt, "d")

    # ---- EX: ALU, eq, branch target -------------------------------------------
    ex_bmux = c.add("plexers.mux", bitsize=32)
    c.wire(idex_b, "q", ex_bmux, "in0")
    c.wire(idex_imm, "q", ex_bmux, "in1")
    exod = c.add("plexers.decoder", inputBits=3)
    c.wire(idex_op, "q", exod, "in")
    # alu_b sel: imm for addi/lw/sw (out2,out3,out4)
    ex_bsel = ctx.gate("or", [(exod, "out2"), (exod, "out3"), (exod, "out4")])
    c.wire(ex_bsel, "out", ex_bmux, "sel")
    adder = c.add("arith.adder", bitsize=32)
    c.wire(idex_a, "q", adder, "a")
    c.wire(ex_bmux, "out", adder, "b")
    c.wire(ctx.zero, "out", adder, "cin")
    nand = c.add("gate.nand", bitsize=32)
    c.wire(idex_a, "q", nand, "in0")
    c.wire(ex_bmux, "out", nand, "in1")
    alu_mux = c.add("plexers.mux", bitsize=32)
    c.wire(adder, "out", alu_mux, "in0")
    c.wire(nand, "out", alu_mux, "in1")
    c.wire(exod, "out1", alu_mux, "sel")  # nand
    ex_eq = eq32(ctx, idex_a, "q", idex_b, "q")
    tgt_adder = c.add("arith.adder", bitsize=32)
    c.wire(idex_pc1, "q", tgt_adder, "a")
    c.wire(idex_imm, "q", tgt_adder, "b")
    c.wire(ctx.zero, "out", tgt_adder, "cin")
    branch_taken = ctx.gate("and", [(exod, "out5"), (ex_eq, "out"), (idex_v, "q")])

    # ---- EX/MEM ---------------------------------------------------------------
    exmem_alu = ctx.reg(bitsize=32, en="tie")
    exmem_b = ctx.reg(bitsize=32, en="tie")
    exmem_op = ctx.reg(bitsize=3, en="tie")
    exmem_rd = ctx.reg(bitsize=4, en="tie")
    exmem_v = ctx.reg(bitsize=1, en="tie")
    c.wire(alu_mux, "out", exmem_alu, "d")
    c.wire(idex_b, "q", exmem_b, "d")
    c.wire(idex_op, "q", exmem_op, "d")
    c.wire(idex_rd, "q", exmem_rd, "d")

    # ---- MEM ------------------------------------------------------------------
    dmem = c.add("mem.ram", name="dmem", bitsize=32, depth=256)
    ao_lo = low_bits(ctx, exmem_alu, "q", 8)
    c.wire(ao_lo, "lo", dmem, "addr")
    c.wire(ctx.clk, "out", dmem, "clk")
    c.wire(exmem_b, "q", dmem, "din")
    memod = c.add("plexers.decoder", inputBits=3)
    c.wire(exmem_op, "q", memod, "in")
    dmem_we = ctx.gate("and", [(memod, "out4"), (exmem_v, "q")])
    c.wire(dmem_we, "out", dmem, "we")

    # ---- MEM/WB ---------------------------------------------------------------
    memwb_alu = ctx.reg(bitsize=32, en="tie")
    memwb_mdr = ctx.reg(bitsize=32, en="tie")
    memwb_op = ctx.reg(bitsize=3, en="tie")
    memwb_rd = ctx.reg(bitsize=4, en="tie")
    memwb_v = ctx.reg(bitsize=1, en="tie")
    c.wire(exmem_alu, "q", memwb_alu, "d")
    c.wire(dmem, "dout", memwb_mdr, "d")
    c.wire(exmem_op, "q", memwb_op, "d")
    c.wire(exmem_rd, "q", memwb_rd, "d")

    # ---- WB -------------------------------------------------------------------
    wbod = c.add("plexers.decoder", inputBits=3)
    c.wire(memwb_op, "q", wbod, "in")
    wb_mux = c.add("plexers.mux", bitsize=32)
    c.wire(memwb_alu, "q", wb_mux, "in0")
    c.wire(memwb_mdr, "q", wb_mux, "in1")
    c.wire(wbod, "out3", wb_mux, "sel")  # lw
    wb_writes = ctx.gate("or", [(wbod, "out0"), (wbod, "out1"), (wbod, "out2"), (wbod, "out3")])
    rf_we = ctx.gate("and", [(wb_writes, "out"), (memwb_v, "q")])
    write_decode(ctx, regs, memwb_rd, "q", rf_we, "out", wb_mux, "out")

    # ---- Hazards: stall (no forwarding) ---------------------------------------
    # A producer is invisible to an ID-stage reader while in ID/EX,
    # EX/MEM, or MEM/WB (the rf write lands at the edge leaving MEM/WB) —
    # all three pipeline stages must be checked.
    idex_writes = ctx.gate("or", [(exod, "out0"), (exod, "out1"), (exod, "out2"), (exod, "out3")])
    exmem_writes = ctx.gate("or", [(memod, "out0"), (memod, "out1"), (memod, "out2"), (memod, "out3")])

    def nz(src, pin):
        # field != 0 via comparator against zero (avoids chaining
        # splitters: f.rs is already a splitter pin — see B11 notes).
        cmp_ = c.add("arith.comparator", bitsize=4)
        c.wire(src, pin, cmp_, "a")
        c.wire(ctx.const(0, 4), "out", cmp_, "b")
        return ctx.not_(cmp_, "eq")

    rs_nz = nz(f, "rs")
    rt_nz = nz(f, "rt")

    def field_haz(fcomp, fpin, fnz):
        terms = []
        for stage_rd, stage_v, stage_w in [
            (idex_rd, idex_v, idex_writes),
            (exmem_rd, exmem_v, exmem_writes),
            (memwb_rd, memwb_v, wb_writes),
        ]:
            cmp_ = c.add("arith.comparator", bitsize=4)
            c.wire(fcomp, fpin, cmp_, "a")
            c.wire(stage_rd, "q", cmp_, "b")
            g = ctx.gate("and", [(cmp_, "eq"), (stage_v, "q"), (stage_w, "out"), (fnz, "out")])
            terms.append((g, "out"))
        return terms

    haz = ctx.gate("or", field_haz(f, "rs", rs_nz) + field_haz(f, "rt", rt_nz))
    stall = ctx.gate("and", [(haz, "out"), (ifid_v, "q")])

    # halt: opcode 6 in ID — PC stops, the fetched instr is killed.
    ifid_od = c.add("plexers.decoder", inputBits=3)
    c.wire(f, "op", ifid_od, "in")
    halt_seen = ctx.gate("and", [(ifid_od, "out6"), (ifid_v, "q")])
    not_stall = ctx.not_(stall, "out")
    not_halt = ctx.not_(halt_seen, "out")
    # A taken branch is OLDER than a stalling IF/ID instruction: the
    # redirect wins even while the hazard stall holds the younger
    # instruction (otherwise the taken branch is silently dropped).
    pc_en = ctx.gate("or", [(not_stall, "out"), (branch_taken, "out")])
    pc_en = ctx.gate("and", [(pc_en, "out"), (not_halt, "out")])

    # flush: branch taken in EX kills IF/ID + ID/EX.
    flush = ctx.gate("buffer", [(branch_taken, "out")])
    not_flush = ctx.not_(flush, "out")

    # pc: taken ? target : pc+1
    pc_mux = c.add("plexers.mux", bitsize=32)
    c.wire(pc_plus1, "out", pc_mux, "in0")
    c.wire(tgt_adder, "out", pc_mux, "in1")
    c.wire(branch_taken, "out", pc_mux, "sel")
    c.wire(pc_mux, "out", pc, "d")
    c.wire(pc_en, "out", pc, "en")

    # IF/ID: hold on stall unless the branch flushes us.
    ifid_en = ctx.gate("or", [(not_stall, "out"), (branch_taken, "out")])
    c.wire(ifid_en, "out", ifid_pc1, "en")
    c.wire(ifid_en, "out", ifid_ir, "en")
    c.wire(ifid_en, "out", ifid_v, "en")
    ifid_v_d = ctx.gate("and", [(not_flush, "out"), (not_halt, "out")])
    c.wire(ifid_v_d, "out", ifid_v, "d")

    # ID/EX valid: bubble on stall/flush/halt, else follow IF/ID.
    idex_v_d = ctx.gate("and", [(ifid_v, "q"), (not_flush, "out"), (not_stall, "out"), (not_halt, "out")])
    c.wire(idex_v_d, "out", idex_v, "d")

    # EX/MEM + MEM/WB valid: always follow.
    c.wire(idex_v, "q", exmem_v, "d")
    c.wire(exmem_v, "q", memwb_v, "d")

    # ---- probes -----------------------------------------------------------------
    c.add("wiring.probe", id="sum", name="sum", bitsize=32)
    c.wire(regs[1], "q", "sum", "in")
    return c.json("pipeline5")


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, gen in [("multicycle.csx", gen_multicycle), ("pipeline5.csx", gen_pipeline5)]:
        doc = gen()
        path = os.path.join(OUT, name)
        with open(path, "w") as fh:
            json.dump(doc, fh, indent=2)
            fh.write("\n")
        print(f"wrote {path} ({len(doc['circuits'][0]['components'])} comps)")
    with open(os.path.join(OUT, "program.hex"), "w") as fh:
        fh.write(PROGRAM_HEX + "\n")
    print(f"program: {PROGRAM_HEX}")


if __name__ == "__main__":
    main()
