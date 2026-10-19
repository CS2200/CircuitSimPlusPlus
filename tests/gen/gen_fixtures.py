#!/usr/bin/env python3
"""Fixture generator for the course-scale .csx fixtures (BACKEND.md B11).

Emits JSON in format v3 (docs/format-v2.md). The fixtures are committed; this
generator is how they were made, and how to regenerate after a format, pin or
delay-table change:

    python3 tests/gen/gen_fixtures.py            # rewrite tests/fixtures/
    python3 tests/gen/gen_fixtures.py --out DIR  # write somewhere else

`scripts/check-fixtures.mjs` (a CI gate) regenerates into a temp dir and diffs
against the committed files, so the two cannot drift apart silently.
"""

import json
import os
import sys

OUT_DEFAULT = os.path.join(os.path.dirname(__file__), "..", "fixtures")
OUT = OUT_DEFAULT


def out_dir():
    """`--out DIR` regenerates elsewhere (used by the CI drift check)."""
    argv = sys.argv[1:]
    if not argv:
        return OUT_DEFAULT
    if len(argv) == 2 and argv[0] == "--out":
        return argv[1]
    raise SystemExit("usage: gen_fixtures.py [--out DIR]")


SETTINGS = {
    "clockHz": 1,
    "delayTable": "cs2200-74ls-v1",
}


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
        if attrs:
            comp["attrs"] = {k: v for k, v in attrs.items() if v is not None}
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
            "version": 3,
            "name": name,
            "settings": SETTINGS,
            "circuits": [{"name": "main", "components": self.components, "wires": self.wires}],
        }


def const(c, value, bitsize=1):
    return c.add("wiring.constant", value=str(value), bitsize=bitsize if bitsize > 1 else None)


def clocked_register(c, clk, one, zero, name=None, bitsize=32):
    """A register with en=1 wired; returns its id."""
    r = c.add("mem.register", name=name, bitsize=bitsize if bitsize != 1 else None)
    c.wire(clk, "out", r, "clk")
    c.wire(one, "out", r, "en")
    return r


# ---------------------------------------------------------------------------
# alu.csx — 32-bit LC-2200 ALU: add, nand, sll, srl, pass-A, pass-B,
# plus an equality flag. Operation selected by 3 inputs (teaching shape:
# one output mux, per-op computed in parallel like the students' ALUs).
# ---------------------------------------------------------------------------
def gen_alu():
    c = Circuit()
    a = c.add("wiring.pin", id="a", name="a", bitsize=32)
    b = c.add("wiring.pin", id="b", name="b", bitsize=32)
    op = c.add("wiring.pin", id="op", name="op", bitsize=3)
    y = c.add("wiring.probe", id="y", name="y", bitsize=32)
    zero_flag = c.add("wiring.probe", id="zero", name="zero")

    adder = c.add("arith.adder", bitsize=32)
    c.wire(a, "pin", adder, "a")
    c.wire(b, "pin", adder, "b")
    cin0 = const(c, 0)
    c.wire(cin0, "out", adder, "cin")

    nand = c.add("gate.nand", bitsize=32)
    c.wire(a, "pin", nand, "in0")
    c.wire(b, "pin", nand, "in1")

    # Shifter amounts are 5 bits (log2 32): b's low 5 via a splitter.
    bsp = c.add("wiring.splitter", splits={"shamt": [0, 1, 2, 3, 4], "hi": list(range(5, 32))})
    c.wire(b, "pin", bsp, "bus")

    sll = c.add("arith.shifter", bitsize=32, shift="ll")  # logical left
    c.wire(a, "pin", sll, "in")
    c.wire(bsp, "shamt", sll, "amt")

    srl = c.add("arith.shifter", bitsize=32, shift="lr")  # logical right
    c.wire(a, "pin", srl, "in")
    c.wire(bsp, "shamt", srl, "amt")

    mux = c.add("plexers.mux", bitsize=32, selectBits=3)
    c.wire(adder, "out", mux, "in0")   # 000 add
    c.wire(nand, "out", mux, "in1")    # 001 nand
    c.wire(sll, "out", mux, "in2")     # 010 sll
    c.wire(srl, "out", mux, "in3")     # 011 srl
    c.wire(a, "pin", mux, "in4")       # 100 pass A
    c.wire(b, "pin", mux, "in5")       # 101 pass B
    c.wire(a, "pin", mux, "in6")       # 110 (pass A, unused)
    c.wire(a, "pin", mux, "in7")       # 111 (pass A, unused)
    c.wire(op, "pin", mux, "sel")
    c.wire(mux, "out", y, "in")

    # zero flag: NOR of all 32 output bits
    sp = c.add("wiring.splitter", splits={f"b{i}": [i] for i in range(32)})
    c.wire(mux, "out", sp, "bus")
    nor = c.add("gate.nor", inputs=32)
    for i in range(32):
        c.wire(sp, f"b{i}", nor, f"in{i}")
    c.wire(nor, "out", zero_flag, "in")
    return c.json("alu")


# ---------------------------------------------------------------------------
# fsm.csx — a 4-state traffic-light-ish sequencer: two state bits, an
# input "car", outputs ns_green / ew_green. Deterministic multi-cycle
# behavior for golden traces; also the controller shape used by the CPUs.
# ---------------------------------------------------------------------------
def gen_fsm():
    c = Circuit()
    clk = c.add("wiring.clock", id="clk")
    one = const(c, 1)
    zero = const(c, 0)
    car = c.add("wiring.pin", id="car", name="car")
    s0 = clocked_register(c, clk, one, zero, name="s0", bitsize=1)
    s1 = clocked_register(c, clk, one, zero, name="s1", bitsize=1)
    ns_g = c.add("wiring.probe", id="ns_green", name="ns_green")
    ew_g = c.add("wiring.probe", id="ew_green", name="ew_green")

    # Next-state: s0' = s0 ^ car ; s1' = (s0 & car) | (s1 & ~s0 & ~car)
    #   (deliberately small; truth verified by the golden test)
    xor0 = c.add("gate.xor")
    c.wire(s0, "q", xor0, "in0")
    c.wire(car, "pin", xor0, "in1")
    c.wire(xor0, "out", s0, "d")

    and0 = c.add("gate.and")
    c.wire(s0, "q", and0, "in0")
    c.wire(car, "pin", and0, "in1")

    not0 = c.add("gate.not")
    c.wire(s0, "q", not0, "in")
    notc = c.add("gate.not")
    c.wire(car, "pin", notc, "in")
    and1 = c.add("gate.and", inputs=3)
    c.wire(s1, "q", and1, "in0")
    c.wire(not0, "out", and1, "in1")
    c.wire(notc, "out", and1, "in2")
    or0 = c.add("gate.or")
    c.wire(and0, "out", or0, "in0")
    c.wire(and1, "out", or0, "in1")
    c.wire(or0, "out", s1, "d")

    # Outputs: ns_green = ~s1 & s0 ; ew_green = s1 & ~s0
    n1 = c.add("gate.not")
    c.wire(s1, "q", n1, "in")
    a_ns = c.add("gate.and")
    c.wire(n1, "out", a_ns, "in0")
    c.wire(s0, "q", a_ns, "in1")
    c.wire(a_ns, "out", ns_g, "in")
    a_ew = c.add("gate.and")
    c.wire(s1, "q", a_ew, "in0")
    c.wire(not0, "out", a_ew, "in1")
    c.wire(a_ew, "out", ew_g, "in")
    return c.json("fsm")


# ---------------------------------------------------------------------------
# Negative fixtures — each must trigger exactly its error class.
# ---------------------------------------------------------------------------
def gen_negative():
    fixtures = {}

    # floating-read: register d driven by a disabled controlled buffer.
    c = Circuit()
    clk = c.add("wiring.clock", id="clk")
    one = const(c, 1)
    zero = const(c, 0)
    buf = c.add("wiring.controlled-buffer")
    c.wire(one, "out", buf, "in")
    c.wire(zero, "out", buf, "en")
    r = clocked_register(c, clk, one, zero, name="r", bitsize=1)
    c.wire(buf, "out", r, "d")
    fixtures["neg-floating-read.csx"] = c.json("neg-floating-read")

    # contention: two enabled buffers driving different values.
    c = Circuit()
    one = const(c, 1)
    zero = const(c, 0)
    b1 = c.add("wiring.controlled-buffer")
    b2 = c.add("wiring.controlled-buffer")
    c.wire(one, "out", b1, "in")
    c.wire(one, "out", b1, "en")
    c.wire(zero, "out", b2, "in")
    c.wire(one, "out", b2, "en")
    p = c.add("wiring.probe", name="bus")
    c.wire(b1, "out", p, "in")
    c.wire(b2, "out", p, "in")
    fixtures["neg-contention.csx"] = c.json("neg-contention")

    # oscillation (zero mode): nand self-loop.
    c = Circuit()
    one = const(c, 1)
    g = c.add("gate.nand")
    c.wire(one, "out", g, "in1")
    c.wire(g, "out", g, "in0")
    p = c.add("wiring.probe", name="p")
    c.wire(g, "out", p, "in")
    fixtures["neg-oscillation.csx"] = c.json("neg-oscillation")

    # setup-violation (driven via timed poke in the golden test; the
    # fixture itself is just a register).
    c = Circuit()
    clk = c.add("wiring.clock", id="clk")
    one = const(c, 1)
    zero = const(c, 0)
    d = c.add("wiring.pin", id="d", name="d")
    r = clocked_register(c, clk, one, zero, name="r", bitsize=1)
    c.wire(d, "pin", r, "d")
    fixtures["neg-setup-violation.csx"] = c.json("neg-setup-violation")

    # bitsize-mismatch: a 1-bit pin wired to a 32-bit pin (netlist error).
    c = Circuit()
    a = c.add("wiring.pin", id="a", name="a")
    b = c.add("wiring.pin", id="b", name="b", bitsize=32)
    c.wire(a, "pin", b, "pin")
    fixtures["neg-bitsize-mismatch.csx"] = c.json("neg-bitsize-mismatch")
    return fixtures


def write_fixture(name, doc):
    path = os.path.join(OUT, name)
    with open(path, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print(f"wrote {path}")


def main():
    global OUT
    OUT = out_dir()
    os.makedirs(OUT, exist_ok=True)
    write_fixture("alu.csx", gen_alu())
    write_fixture("fsm.csx", gen_fsm())
    for name, doc in gen_negative().items():
        write_fixture(name, doc)


if __name__ == "__main__":
    main()
