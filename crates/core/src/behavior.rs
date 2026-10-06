//! Component behaviors (DESIGN.md §6; BACKEND.md task B4).
//!
//! A [`Behavior`] couples a component's *function* (zero-delay evaluation
//! over [`Value`]s) with its *timing parameters* (consumed by the
//! delay-aware engine, task B6) and, for stateful components, its stored
//! state (register value, memory words).
//!
//! Behaviors are constructed from the typed [`CompConfig`] produced by
//! `components::config` — attribute parsing lives in exactly one place
//! (`components::analyze`), so interface and behavior can never drift.
//!
//! ## Pin-order invariant
//!
//! `eval`/`rising_edge` take the component's **input** pins in
//! pin-signature order (`components::pin_sigs` filtered to `dir == In`)
//! and return **output** pin values in pin-signature order (`dir == Out`).
//! The splitter is the exception — all its pins are bidirectional; see
//! [`Behavior::eval_splitter`].
//!
//! ## The floating-consume rule (DESIGN.md §4.1)
//!
//! Consuming a floating (`Z`) value is a simulation-halting error. What
//! counts as *consuming* is defined per component (the strict reading the
//! team approved, D3):
//!
//! | Component | Consumes |
//! |---|---|
//! | gates (incl. not/buffer) | every input |
//! | controlled buffer | `en` always; `in` only while `en ≠ 0` |
//! | mux | `sel` always; the selected data input (all of them if `sel` is X) |
//! | demux / decoder | all inputs |
//! | arithmetic | all inputs |
//! | register (rising edge only) | `en`, `rst` always; `d` only when `en ≠ 0` and `rst ≠ 1` |
//! | RAM | `addr` continuously (async read); `we` at the edge; `din` at the edge when `we ≠ 0` |
//! | ROM | `addr` continuously |
//! | pin / probe / LED / hex display | **nothing** — they *observe*; an idle bus displaying as `Z` is legal (§4.1) |
//! | splitter | **nothing** — it is plumbing; `Z`/`X` flow through to the eventual consumer |
//!
//! When a control input is X (mux select, buffer enable, register
//! enable/reset, RAM write-enable), behaviors consume *conservatively* —
//! any input that could affect the output is consumed.
//!
//! ## Documented semantics decisions (flagged for review)
//!
//! - **Register reset is synchronous** (sampled at the rising edge, wins
//!   over enable) — the course teaches synchronous design (§4.3's register
//!   timing model assumes it).
//! - **Registers and RAM power on at 0** (contents/autoload aside), not X
//!   — matches legacy CircuitSim and keeps grading deterministic.
//! - **RAM addressing:** `depth` is required to be a power of two at load
//!   (validation), so the `addr` pin's width exactly covers `0..depth`.
//!   The defensive past-end path (reads `X`, writes drop) remains for the
//!   `depth = 1` corner (a 1-bit address can still name word 1) and the
//!   lenient post-validation path. A write with `X` in the address is
//!   dropped (target unknown).
//! - **Divide by zero** → quotient and remainder are `X` (honest
//!   "unknown", and it cannot corrupt state — it propagates).
//! - **Mux with X select** outputs the data value if all data inputs are
//!   equal, else `X` (the classic three-valued-logic rule).

use serde_json::{Map, Value as Json};

use crate::components::{CompConfig, CompKind, ExtendMode, GateOp, ShiftMode};
use crate::value::{Bit, Value};

/// A floating (`Z`) value reached a consumer that requires a driven value
/// (DESIGN.md §4.1). The engine wraps this with the component's identity
/// (`FlatComp::origin`) and halts with `HaltReason::FloatingRead`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("floating (Z) value consumed at pin '{pin}'")]
pub struct FloatingRead {
    /// Name of the consuming pin (matches `components::pin_sigs`).
    pub pin: String,
}

impl FloatingRead {
    fn at(pin: impl Into<String>) -> Self {
        FloatingRead { pin: pin.into() }
    }
}

/// Timing parameters the delay-aware engine (task B6) reads from a
/// behavior. All values in the delay table's units (ns).
///
/// - `prop`: combinational propagation delay; for state elements, clk→Q.
/// - `setup` / `hold`: register and RAM write discipline (§4.3).
/// - `access`: RAM/ROM read settling time.
///
/// **DRAFT:** the defaults below are the DESIGN.md §4.4 (D13) anchors; task
/// B7 replaces the default source with the published delay table
/// (`cs2200-74ls-v1`). `attrs.delay` always overrides `prop` per instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Timing {
    pub prop: u64,
    pub setup: u64,
    pub hold: u64,
    pub access: u64,
}

// DRAFT 74LS anchors (DESIGN.md §4.4) — B7 moves these into the table.
pub const T_PD_NOT: u64 = 9;
pub const T_PD_GATE: u64 = 10;
pub const T_PD_XOR: u64 = 12;
pub const T_PD_MUX: u64 = 12;
pub const T_PD_ARITH: u64 = 15;
pub const T_CLK_TO_Q: u64 = 20;
pub const T_SETUP: u64 = 15;
pub const T_HOLD: u64 = 5;
pub const T_ACCESS: u64 = 50;

/// Consume check: a pin that requires a driven value (module docs).
fn consume(v: &Value, pin: impl Into<String>) -> Result<(), FloatingRead> {
    if v.has_z() {
        Err(FloatingRead::at(pin))
    } else {
        Ok(())
    }
}

/// All inputs known? (Arithmetic produces all-X outputs otherwise.)
fn all_known(ins: &[&Value]) -> bool {
    ins.iter().all(|v| v.is_fully_known())
}

/// Bit 0 as a control signal. `Z` never reaches here (consumed first).
fn ctl(v: &Value) -> Bit {
    debug_assert!(!v.has_z(), "control value still floating after consume");
    v.bit(0)
}

/// Component behavior: kind (config + state) plus the per-instance delay
/// override. Construct via [`Behavior::new`]; evaluate via [`Behavior::eval`].
#[derive(Debug, Clone)]
pub struct Behavior {
    kind: BehaviorKind,
    delay: Option<u64>,
}

#[derive(Debug, Clone)]
enum BehaviorKind {
    Not,
    Buffer,
    Gate {
        op: GateOp,
        bitsize: u32,
        /// Per-input negation bubbles, indexed like the `in{i}` pins.
        negate: Vec<bool>,
    },
    ControlledBuffer {
        bitsize: u32,
    },
    /// Root-circuit pin. Input pins hold the driven (poked) value; output
    /// pins are pure observation points (their value lives on the net).
    Pin {
        is_output: bool,
        value: Value,
    },
    Constant {
        value: Value,
    },
    Clock {
        phase: bool,
    },
    Splitter {
        splits: Vec<(String, Vec<u32>)>,
        bus_width: u32,
    },
    Probe,
    Mux {
        bitsize: u32,
        select_bits: u32,
    },
    Demux {
        bitsize: u32,
        select_bits: u32,
    },
    Decoder {
        input_bits: u32,
    },
    Adder {
        bitsize: u32,
    },
    Subtractor {
        bitsize: u32,
    },
    Multiplier {
        bitsize: u32,
    },
    Divider {
        bitsize: u32,
    },
    Comparator,
    Negator,
    Shifter {
        mode: ShiftMode,
    },
    BitExtender {
        out_bits: u32,
        mode: ExtendMode,
    },
    Register {
        state: Value,
    },
    Ram {
        bitsize: u32,
        words: Vec<Value>,
        autoload: Option<String>,
    },
    Rom {
        bitsize: u32,
        words: Vec<Value>,
        autoload: Option<String>,
    },
    Button {
        pressed: bool,
    },
    Led,
    HexDisplay,
}

/// Initialize memory words from an optional embedded `rle-hex-v1` image;
/// missing words are zero. (Post-validation, a malformed image is
/// impossible; the lenient fallback is zeros.)
fn init_words(bitsize: u32, depth: u32, contents: &Option<String>) -> Vec<Value> {
    let mut words = Vec::with_capacity(depth as usize);
    if let Some(image) = contents {
        if let Ok(raw) = crate::format::rle::parse(image, depth as usize) {
            for w in raw {
                words.push(Value::from_u64(bitsize, w));
            }
        }
    }
    words.resize(depth as usize, Value::zero(bitsize));
    words
}

impl Behavior {
    /// Build the behavior for a typed component configuration. Returns
    /// `None` for `subcircuit` — subcircuits are inlined at netlist build
    /// (task B3), so a flattened design never contains one.
    pub fn new(cfg: &CompConfig) -> Option<Behavior> {
        let kind = match &cfg.kind {
            CompKind::Not { .. } => BehaviorKind::Not,
            CompKind::Buffer { .. } => BehaviorKind::Buffer,
            CompKind::Gate {
                op,
                bitsize,
                inputs,
                negate_inputs,
            } => {
                let mut negate = vec![false; *inputs as usize];
                for name in negate_inputs {
                    if let Some(i) = name
                        .strip_prefix("in")
                        .and_then(|s| s.parse::<usize>().ok())
                    {
                        if i < negate.len() {
                            negate[i] = true;
                        }
                    }
                }
                BehaviorKind::Gate {
                    op: *op,
                    bitsize: *bitsize,
                    negate,
                }
            }
            CompKind::ControlledBuffer { bitsize } => {
                BehaviorKind::ControlledBuffer { bitsize: *bitsize }
            }
            CompKind::Pin { bitsize, is_output } => BehaviorKind::Pin {
                is_output: *is_output,
                value: Value::zero(*bitsize),
            },
            CompKind::Constant { value, .. } => BehaviorKind::Constant {
                value: value.clone(),
            },
            CompKind::Clock => BehaviorKind::Clock { phase: false },
            CompKind::Splitter { splits, bus_width } => BehaviorKind::Splitter {
                splits: splits.clone(),
                bus_width: *bus_width,
            },
            CompKind::Probe { .. } => BehaviorKind::Probe,
            CompKind::Mux {
                bitsize,
                select_bits,
            } => BehaviorKind::Mux {
                bitsize: *bitsize,
                select_bits: *select_bits,
            },
            CompKind::Demux {
                bitsize,
                select_bits,
            } => BehaviorKind::Demux {
                bitsize: *bitsize,
                select_bits: *select_bits,
            },
            CompKind::Decoder { input_bits } => BehaviorKind::Decoder {
                input_bits: *input_bits,
            },
            CompKind::Adder { bitsize } => BehaviorKind::Adder { bitsize: *bitsize },
            CompKind::Subtractor { bitsize } => BehaviorKind::Subtractor { bitsize: *bitsize },
            CompKind::Multiplier { bitsize } => BehaviorKind::Multiplier { bitsize: *bitsize },
            CompKind::Divider { bitsize } => BehaviorKind::Divider { bitsize: *bitsize },
            CompKind::Comparator { .. } => BehaviorKind::Comparator,
            CompKind::Negator { .. } => BehaviorKind::Negator,
            CompKind::Shifter { mode, .. } => BehaviorKind::Shifter { mode: *mode },
            CompKind::BitExtender { out_bits, mode, .. } => BehaviorKind::BitExtender {
                out_bits: *out_bits,
                mode: *mode,
            },
            CompKind::Register { bitsize } => BehaviorKind::Register {
                state: Value::zero(*bitsize),
            },
            CompKind::Ram {
                bitsize,
                depth,
                autoload,
                contents,
            } => BehaviorKind::Ram {
                bitsize: *bitsize,
                words: init_words(*bitsize, *depth, contents),
                autoload: autoload.clone(),
            },
            CompKind::Rom {
                bitsize,
                depth,
                autoload,
                contents,
            } => BehaviorKind::Rom {
                bitsize: *bitsize,
                words: init_words(*bitsize, *depth, contents),
                autoload: autoload.clone(),
            },
            CompKind::Button => BehaviorKind::Button { pressed: false },
            CompKind::Led { .. } => BehaviorKind::Led,
            CompKind::HexDisplay { .. } => BehaviorKind::HexDisplay,
            CompKind::Subcircuit { .. } => return None,
        };
        Some(Behavior {
            kind,
            delay: cfg.delay,
        })
    }

    /// True for components with clocked state (register, RAM) — the
    /// engines' cut points (DESIGN.md §4.2).
    pub fn is_clocked(&self) -> bool {
        matches!(
            self.kind,
            BehaviorKind::Register { .. } | BehaviorKind::Ram { .. }
        )
    }

    /// True for the splitter (bidirectional; evaluated via
    /// [`Behavior::eval_splitter`], not `eval`).
    pub fn is_splitter(&self) -> bool {
        matches!(self.kind, BehaviorKind::Splitter { .. })
    }

    /// Combinational evaluation: input pin values (pin-signature order
    /// among `In` pins) → output pin values (order among `Out` pins).
    /// Pure — never mutates state. Errors per the floating-consume rule
    /// (module docs).
    pub fn eval(&self, ins: &[&Value]) -> Result<Vec<Value>, FloatingRead> {
        match &self.kind {
            BehaviorKind::Not => {
                consume(ins[0], "in")?;
                Ok(vec![ins[0].not()])
            }
            BehaviorKind::Buffer => {
                consume(ins[0], "in")?;
                Ok(vec![ins[0].clone()])
            }
            BehaviorKind::Gate {
                op,
                bitsize,
                negate,
            } => {
                for (i, v) in ins.iter().enumerate() {
                    consume(v, format!("in{i}"))?;
                }
                let (base, invert) = op.base();
                let mut acc = match base {
                    GateOp::And => Value::all_ones(*bitsize),
                    _ => Value::zero(*bitsize),
                };
                for (i, v) in ins.iter().enumerate() {
                    let v = if negate[i] { v.not() } else { (*v).clone() };
                    acc = match base {
                        GateOp::And => acc.and(&v),
                        GateOp::Or => acc.or(&v),
                        _ => acc.xor(&v),
                    };
                }
                if invert {
                    acc = acc.not();
                }
                Ok(vec![acc])
            }
            BehaviorKind::ControlledBuffer { bitsize } => {
                let (data, en) = (ins[0], ins[1]);
                consume(en, "en")?;
                match ctl(en) {
                    Bit::Zero => Ok(vec![Value::z(*bitsize)]),
                    Bit::One => {
                        consume(data, "in")?;
                        Ok(vec![data.clone()])
                    }
                    // en = X: the driver might be enabled — consume data
                    // conservatively, output unknown.
                    _ => {
                        consume(data, "in")?;
                        Ok(vec![Value::x(*bitsize)])
                    }
                }
            }
            BehaviorKind::Pin { is_output, value } => {
                if *is_output {
                    Ok(vec![]) // observation point
                } else {
                    Ok(vec![value.clone()])
                }
            }
            BehaviorKind::Constant { value } => Ok(vec![value.clone()]),
            BehaviorKind::Clock { phase } => Ok(vec![Value::from_u64(1, u64::from(*phase))]),
            BehaviorKind::Splitter { .. } => {
                unreachable!("splitters evaluate via eval_splitter (bidirectional pins)")
            }
            BehaviorKind::Probe | BehaviorKind::Led | BehaviorKind::HexDisplay => Ok(vec![]),
            BehaviorKind::Mux {
                bitsize,
                select_bits,
            } => {
                let n = 1usize << select_bits;
                let (data, sel) = (ins[..n].to_vec(), ins[n]);
                consume(sel, "sel")?;
                if sel.is_fully_known() {
                    let i = sel.to_u64().expect("select fits in u64") as usize;
                    consume(data[i], format!("in{i}"))?;
                    Ok(vec![data[i].clone()])
                } else {
                    // X select: any input might be selected — consume all.
                    for (i, v) in data.iter().enumerate() {
                        consume(v, format!("in{i}"))?;
                    }
                    if data.iter().all(|v| v == &data[0]) {
                        Ok(vec![data[0].clone()])
                    } else {
                        Ok(vec![Value::x(*bitsize)])
                    }
                }
            }
            BehaviorKind::Demux {
                bitsize,
                select_bits,
            } => {
                let (data, sel) = (ins[0], ins[1]);
                consume(data, "in")?;
                consume(sel, "sel")?;
                let n = 1usize << select_bits;
                if sel.is_fully_known() {
                    let i = sel.to_u64().expect("select fits in u64") as usize;
                    let mut outs = vec![Value::zero(*bitsize); n];
                    outs[i] = data.clone();
                    Ok(outs)
                } else {
                    Ok(vec![Value::x(*bitsize); n])
                }
            }
            BehaviorKind::Decoder { input_bits } => {
                let input = ins[0];
                consume(input, "in")?;
                let n = 1usize << input_bits;
                if input.is_fully_known() {
                    let i = input.to_u64().expect("input fits in u64") as usize;
                    let mut outs = vec![Value::zero(1); n];
                    outs[i] = Value::from_u64(1, 1);
                    Ok(outs)
                } else {
                    Ok(vec![Value::x(1); n])
                }
            }
            BehaviorKind::Adder { bitsize } => {
                for (v, name) in ins.iter().zip(["a", "b", "cin"]) {
                    consume(v, name)?;
                }
                if all_known(ins) {
                    let (sum, cout) = ins[0].add(ins[1], ctl(ins[2]) == Bit::One);
                    Ok(vec![sum, cout])
                } else {
                    Ok(vec![Value::x(*bitsize), Value::x(1)])
                }
            }
            BehaviorKind::Subtractor { bitsize } => {
                for (v, name) in ins.iter().zip(["a", "b", "bin"]) {
                    consume(v, name)?;
                }
                if all_known(ins) {
                    let (diff, bout) = ins[0].sub(ins[1], ctl(ins[2]) == Bit::One);
                    Ok(vec![diff, bout])
                } else {
                    Ok(vec![Value::x(*bitsize), Value::x(1)])
                }
            }
            BehaviorKind::Multiplier { bitsize } => {
                for (v, name) in ins.iter().zip(["a", "b"]) {
                    consume(v, name)?;
                }
                if all_known(ins) {
                    Ok(vec![ins[0].mul(ins[1])])
                } else {
                    Ok(vec![Value::x(2 * bitsize)])
                }
            }
            BehaviorKind::Divider { bitsize } => {
                for (v, name) in ins.iter().zip(["a", "b"]) {
                    consume(v, name)?;
                }
                if !all_known(ins) {
                    return Ok(vec![Value::x(*bitsize), Value::x(*bitsize)]);
                }
                match ins[0].div_rem(ins[1]) {
                    Some((q, r)) => Ok(vec![q, r]),
                    // Divide by zero → unknown (documented, module header).
                    None => Ok(vec![Value::x(*bitsize), Value::x(*bitsize)]),
                }
            }
            BehaviorKind::Comparator => {
                for (v, name) in ins.iter().zip(["a", "b"]) {
                    consume(v, name)?;
                }
                Ok(match ins[0].compare(ins[1]) {
                    Some(std::cmp::Ordering::Less) => vec![one(), zero(), zero()],
                    Some(std::cmp::Ordering::Equal) => vec![zero(), one(), zero()],
                    Some(std::cmp::Ordering::Greater) => vec![zero(), zero(), one()],
                    None => vec![Value::x(1), Value::x(1), Value::x(1)],
                })
            }
            BehaviorKind::Negator => {
                consume(ins[0], "in")?;
                Ok(vec![ins[0].neg()])
            }
            BehaviorKind::Shifter { mode } => {
                consume(ins[0], "in")?;
                consume(ins[1], "amt")?;
                if all_known(ins) {
                    let n = ins[1].to_u64().expect("shift amount fits in u64") as u32;
                    Ok(vec![match mode {
                        ShiftMode::LogicalLeft => ins[0].shl(n),
                        ShiftMode::LogicalRight => ins[0].shr(n),
                        ShiftMode::ArithRight => ins[0].sar(n),
                        ShiftMode::RotateLeft => ins[0].rotl(n),
                        ShiftMode::RotateRight => ins[0].rotr(n),
                    }])
                } else {
                    Ok(vec![Value::x(ins[0].width())])
                }
            }
            BehaviorKind::BitExtender { out_bits, mode } => {
                consume(ins[0], "in")?;
                Ok(vec![match mode {
                    ExtendMode::Zero => ins[0].zero_extend(*out_bits),
                    ExtendMode::Sign => ins[0].sign_extend(*out_bits),
                }])
            }
            BehaviorKind::Register { state } => Ok(vec![state.clone()]),
            BehaviorKind::Ram { bitsize, words, .. } => {
                let addr = ins[0];
                consume(addr, "addr")?;
                Ok(vec![match addr.to_u64() {
                    Some(a) if (a as usize) < words.len() => words[a as usize].clone(),
                    // X in the address, or past-end address (non-power-of-2
                    // depth): data unknown (documented, module header).
                    _ => Value::x(*bitsize),
                }])
            }
            BehaviorKind::Rom { bitsize, words, .. } => {
                let addr = ins[0];
                consume(addr, "addr")?;
                Ok(vec![match addr.to_u64() {
                    Some(a) if (a as usize) < words.len() => words[a as usize].clone(),
                    _ => Value::x(*bitsize),
                }])
            }
            BehaviorKind::Button { pressed } => Ok(vec![Value::from_u64(1, u64::from(*pressed))]),
        }
    }

    /// Rising clock edge: latch/write for clocked components (register,
    /// RAM); no-op for everything else. Consumes control inputs per the
    /// module-header table. The engine calls this only when it observed a
    /// 0→1 transition on the `clk` net.
    pub fn rising_edge(&mut self, ins: &[&Value]) -> Result<(), FloatingRead> {
        match &mut self.kind {
            BehaviorKind::Register { state } => {
                let (d, en, rst) = (ins[0], ins[2], ins[3]);
                consume(en, "en")?;
                consume(rst, "rst")?;
                let w = state.width();
                match ctl(rst) {
                    // Synchronous reset wins over enable.
                    Bit::One => *state = Value::zero(w),
                    Bit::X => {
                        if ctl(en) != Bit::Zero {
                            consume(d, "d")?;
                        }
                        *state = Value::x(w);
                    }
                    Bit::Zero => match ctl(en) {
                        Bit::One => {
                            consume(d, "d")?;
                            *state = d.clone();
                        }
                        Bit::X => {
                            consume(d, "d")?;
                            *state = Value::x(w);
                        }
                        _ => {} // hold
                    },
                    Bit::Z => unreachable!("rst consumed above"),
                }
                Ok(())
            }
            BehaviorKind::Ram { bitsize, words, .. } => {
                let (addr, din, we) = (ins[0], ins[1], ins[2]);
                consume(we, "we")?;
                match ctl(we) {
                    Bit::Zero => Ok(()),
                    we_bit => {
                        consume(din, "din")?;
                        // addr is already consumed continuously by eval
                        // (async read); a floating address halts there.
                        match addr.to_u64() {
                            Some(a) if (a as usize) < words.len() => {
                                words[a as usize] = match we_bit {
                                    Bit::One => din.clone(),
                                    // we = X: the write may have happened.
                                    _ => Value::x(*bitsize),
                                };
                            }
                            // X address or past-end: write dropped
                            // (documented, module header).
                            _ => {}
                        }
                        Ok(())
                    }
                }
            }
            _ => Ok(()),
        }
    }

    /// Splitter resolution (bidirectional bus plumbing — not a gate).
    /// `nets[i]` is the value driven onto pin `i`'s net by *other*
    /// components (all-`Z` = nothing else drives); pin order is
    /// pin-signature order (`bus` first, then split pins sorted by name).
    /// Returns the value the splitter drives onto each pin's net; the
    /// engine merges those with the other drivers' contributions
    /// (`Value::contention_merge`), which is what makes a driven conflict
    /// show up as `X` on *both* sides of the short.
    ///
    /// Never errors: `Z` and `X` flow through to the eventual consumer.
    pub fn eval_splitter(&self, nets: &[Value]) -> Vec<Value> {
        let BehaviorKind::Splitter { splits, bus_width } = &self.kind else {
            panic!("eval_splitter on non-splitter (engine bug)");
        };
        debug_assert_eq!(nets.len(), 1 + splits.len(), "splitter pin count");
        // Resolve the bus bit-by-bit: others' drive on the bus net merged
        // with the driven splits' contributions (contention → X).
        let mut resolved: Vec<Bit> = (0..*bus_width).map(|i| nets[0].bit(i)).collect();
        for (si, (_, map)) in splits.iter().enumerate() {
            let v = &nets[1 + si];
            for (j, &bus_bit) in map.iter().enumerate() {
                if bus_bit >= *bus_width {
                    continue; // lenient path (invalid splits) — validation reported it
                }
                let split_bit = if (j as u32) < v.width() {
                    v.bit(j as u32)
                } else {
                    Bit::Z
                };
                let b = &mut resolved[bus_bit as usize];
                *b = merge_bit(*b, split_bit);
            }
        }
        // Drive: the bus gets the full resolution; each split pin gets its
        // bits back out of the resolution (so split→bus→split flows).
        let mut out = Vec::with_capacity(nets.len());
        out.push(Value::from_bits(&resolved));
        for (_, map) in splits.iter() {
            out.push(Value::from_bits(
                &map.iter()
                    .map(|&bb| {
                        if bb < *bus_width {
                            resolved[bb as usize]
                        } else {
                            Bit::Z
                        }
                    })
                    .collect::<Vec<_>>(),
            ));
        }
        out
    }

    /// Timing parameters (see [`Timing`]). DRAFT defaults until task B7.
    pub fn timing(&self) -> Timing {
        let prop = match &self.kind {
            BehaviorKind::Not | BehaviorKind::Buffer => T_PD_NOT,
            BehaviorKind::Gate { op, .. } => match op.base().0 {
                GateOp::Xor => T_PD_XOR,
                _ => T_PD_GATE,
            },
            BehaviorKind::ControlledBuffer { .. } => T_PD_GATE,
            BehaviorKind::Mux { .. }
            | BehaviorKind::Demux { .. }
            | BehaviorKind::Decoder { .. } => T_PD_MUX,
            BehaviorKind::Adder { .. }
            | BehaviorKind::Subtractor { .. }
            | BehaviorKind::Multiplier { .. }
            | BehaviorKind::Divider { .. }
            | BehaviorKind::Comparator
            | BehaviorKind::Negator
            | BehaviorKind::Shifter { .. } => T_PD_ARITH,
            BehaviorKind::Register { .. } => T_CLK_TO_Q,
            // Ideal/pure-wiring parts.
            _ => 0,
        };
        let mut t = Timing {
            prop,
            ..Timing::default()
        };
        match &self.kind {
            BehaviorKind::Register { .. } => {
                t.setup = T_SETUP;
                t.hold = T_HOLD;
            }
            BehaviorKind::Ram { .. } => {
                t.access = T_ACCESS;
                t.setup = T_SETUP;
                t.hold = T_HOLD;
            }
            BehaviorKind::Rom { .. } => t.access = T_ACCESS,
            _ => {}
        }
        if let Some(d) = self.delay {
            t.prop = d; // per-instance override (DESIGN.md §4.3)
        }
        t
    }

    // -- Engine/poke/autograder accessors ---------------------------------

    /// Drive an input pin (interactive poking / test setup, `Sim::poke`).
    pub fn set_pin_value(&mut self, v: Value) {
        if let BehaviorKind::Pin { is_output, value } = &mut self.kind {
            debug_assert!(!*is_output, "poke: output pins are read-only");
            *value = v;
        }
    }

    /// Press/release a button.
    pub fn set_pressed(&mut self, p: bool) {
        if let BehaviorKind::Button { pressed } = &mut self.kind {
            *pressed = p;
        }
    }

    /// Set a clock component's current phase (the engines own the global
    /// clock; every clock component mirrors it, DESIGN.md §4.7).
    pub fn set_phase(&mut self, p: bool) {
        if let BehaviorKind::Clock { phase } = &mut self.kind {
            *phase = p;
        }
    }

    /// A register's current stored value (autograder read).
    pub fn register_value(&self) -> Option<&Value> {
        match &self.kind {
            BehaviorKind::Register { state } => Some(state),
            _ => None,
        }
    }

    /// Memory word count (RAM/ROM), for bounds-checked autograder access.
    pub fn memory_len(&self) -> Option<usize> {
        match &self.kind {
            BehaviorKind::Ram { words, .. } | BehaviorKind::Rom { words, .. } => Some(words.len()),
            _ => None,
        }
    }

    /// Read a memory word (autograder `mem_read`).
    pub fn memory_word(&self, addr: usize) -> Option<Value> {
        match &self.kind {
            BehaviorKind::Ram { words, .. } | BehaviorKind::Rom { words, .. } => {
                words.get(addr).cloned()
            }
            _ => None,
        }
    }

    /// Write a memory word (autograder `mem_write`; RAM only — ROMs are
    /// read-only at runtime but accept pre-run image loads via
    /// [`Behavior::load_words`]).
    pub fn set_memory_word(&mut self, addr: usize, v: Value) {
        if let BehaviorKind::Ram { words, .. } = &mut self.kind {
            if addr < words.len() {
                words[addr] = v;
            }
        }
    }

    /// Bulk-load a memory image (autoload / `--load`, tasks B9/B10).
    /// Extra words are ignored; missing words are zero.
    pub fn load_words(&mut self, image: &[u64]) {
        let words = match &mut self.kind {
            BehaviorKind::Ram { words, .. } | BehaviorKind::Rom { words, .. } => words,
            _ => return,
        };
        for (i, w) in image.iter().enumerate() {
            if i >= words.len() {
                break;
            }
            let bitsize = words[i].width();
            words[i] = Value::from_u64(bitsize, *w);
        }
    }

    /// The `autoload` path of a memory (resolved/sandboxed by the loader,
    /// task B9, per DESIGN.md §11).
    pub fn autoload(&self) -> Option<&str> {
        match &self.kind {
            BehaviorKind::Ram { autoload, .. } | BehaviorKind::Rom { autoload, .. } => {
                autoload.as_deref()
            }
            _ => None,
        }
    }

    /// Which eval inputs combinationally affect the outputs (the zero-delay
    /// engine's levelization, task B5). Indices are positions in the eval
    /// `ins` slice (input pins in pin-signature order). Default: all inputs.
    pub fn comb_input_deps(&self, n_inputs: usize) -> Vec<usize> {
        match &self.kind {
            // q comes from internal state only.
            BehaviorKind::Register { .. } => Vec::new(),
            // dout = f(state, addr) — din/we/clk only matter at the edge.
            BehaviorKind::Ram { .. } => vec![0],
            _ => (0..n_inputs).collect(),
        }
    }

    /// Snapshot of internal state (task B5 savestates). JSON-encoded via
    /// the IPC `WireValue` hex masks — deterministic by construction.
    pub fn save_state(&self) -> Json {
        match &self.kind {
            BehaviorKind::Register { state } => value_to_json(state),
            BehaviorKind::Ram { words, .. } | BehaviorKind::Rom { words, .. } => {
                Json::Array(words.iter().map(value_to_json).collect())
            }
            BehaviorKind::Pin {
                is_output: false,
                value,
            } => value_to_json(value),
            BehaviorKind::Button { pressed } => Json::Bool(*pressed),
            BehaviorKind::Clock { phase } => Json::Bool(*phase),
            _ => Json::Null,
        }
    }

    /// Restore a snapshot produced by [`Behavior::save_state`]. Returns
    /// `false` on shape/width mismatch (snapshot from a different circuit).
    pub fn load_state(&mut self, state: &Json) -> bool {
        match &mut self.kind {
            BehaviorKind::Register { state: s } => {
                let Some(v) = value_from_json(state, s.width()) else {
                    return false;
                };
                *s = v;
                true
            }
            BehaviorKind::Ram { words, .. } | BehaviorKind::Rom { words, .. } => {
                let Json::Array(items) = state else {
                    return false;
                };
                if items.len() != words.len() {
                    return false;
                }
                for (w, item) in words.iter_mut().zip(items) {
                    let Some(v) = value_from_json(item, w.width()) else {
                        return false;
                    };
                    *w = v;
                }
                true
            }
            BehaviorKind::Pin {
                is_output: false,
                value,
            } => {
                let Some(v) = value_from_json(state, value.width()) else {
                    return false;
                };
                *value = v;
                true
            }
            BehaviorKind::Button { pressed } => {
                let Some(b) = state.as_bool() else {
                    return false;
                };
                *pressed = b;
                true
            }
            BehaviorKind::Clock { phase } => {
                let Some(b) = state.as_bool() else {
                    return false;
                };
                *phase = b;
                true
            }
            // Stateless kinds accept (and ignore) the null placeholder.
            _ => state.is_null(),
        }
    }
}

fn value_to_json(v: &Value) -> Json {
    serde_json::to_value(v.to_wire_value()).expect("WireValue serializes")
}

fn value_from_json(j: &Json, width: u32) -> Option<Value> {
    let wv: crate::api::WireValue = serde_json::from_value(j.clone()).ok()?;
    Value::from_wire_value(&wv, width).ok()
}

/// One bit of the splitter's per-bit resolution: two candidate drives
/// (`Z` = no drive); agreement → that value, disagreement → `X`.
fn merge_bit(a: Bit, b: Bit) -> Bit {
    match (a, b) {
        (Bit::Z, x) | (x, Bit::Z) => x,
        (Bit::X, _) | (_, Bit::X) => Bit::X,
        (x, y) if x == y => x,
        _ => Bit::X,
    }
}

fn zero() -> Value {
    Value::zero(1)
}
fn one() -> Value {
    Value::from_u64(1, 1)
}

/// Convenience for engines: build a behavior straight from the raw
/// `(type, attrs)` pair (wrapping `components::config` + `Behavior::new`).
pub fn from_type_attrs(type_: &str, attrs: &Map<String, Json>) -> Option<Behavior> {
    let cfg = crate::components::config(type_, attrs)?;
    Behavior::new(&cfg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mk(type_: &str, attrs: Json) -> Behavior {
        let attrs = attrs.as_object().unwrap().clone();
        let cfg = crate::components::config(type_, &attrs).unwrap();
        Behavior::new(&cfg).unwrap()
    }

    fn k(width: u32, v: u64) -> Value {
        Value::from_u64(width, v)
    }

    fn refs(vs: &[Value]) -> Vec<&Value> {
        vs.iter().collect()
    }

    const KNOWN: [Bit; 3] = [Bit::Zero, Bit::One, Bit::X];

    // ---- Gates -------------------------------------------------------

    #[test]
    fn gate_truth_tables_incl_x() {
        let ops = [
            ("gate.and", GateOp::And),
            ("gate.or", GateOp::Or),
            ("gate.xor", GateOp::Xor),
            ("gate.nand", GateOp::Nand),
            ("gate.nor", GateOp::Nor),
            ("gate.xnor", GateOp::Xnor),
        ];
        for (type_, op) in ops {
            let g = mk(type_, json!({}));
            for a in KNOWN {
                for b in KNOWN {
                    let ins = [Value::from_bits(&[a]), Value::from_bits(&[b])];
                    let out = g.eval(&refs(&ins)).unwrap();
                    // Reference truth tables (three-valued logic).
                    let base = match op.base().0 {
                        GateOp::And => match (a, b) {
                            (Bit::Zero, _) | (_, Bit::Zero) => Bit::Zero,
                            (Bit::One, Bit::One) => Bit::One,
                            _ => Bit::X,
                        },
                        GateOp::Or => match (a, b) {
                            (Bit::One, _) | (_, Bit::One) => Bit::One,
                            (Bit::Zero, Bit::Zero) => Bit::Zero,
                            _ => Bit::X,
                        },
                        _ => match (a, b) {
                            (Bit::X, _) | (_, Bit::X) => Bit::X,
                            (x, y) if x == y => Bit::Zero,
                            _ => Bit::One,
                        },
                    };
                    let expect = if op.base().1 { not_bit(base) } else { base };
                    assert_eq!(out[0], Value::from_bits(&[expect]), "{type_}({a}, {b})");
                }
            }
        }
    }

    fn not_bit(b: Bit) -> Bit {
        match b {
            Bit::Zero => Bit::One,
            Bit::One => Bit::Zero,
            x => x,
        }
    }

    #[test]
    fn gate_multi_input_and_wide() {
        let g = mk("gate.and", json!({"inputs": 4, "bitsize": 8}));
        let ins = [k(8, 0xFF), k(8, 0xF0), k(8, 0xCC), k(8, 0xAA)];
        assert_eq!(g.eval(&refs(&ins)).unwrap(), vec![k(8, 0x80)]);
        // One low input dominates.
        let ins = [k(8, 0xFF), k(8, 0x00), k(8, 0xFF), k(8, 0xFF)];
        assert_eq!(g.eval(&refs(&ins)).unwrap(), vec![k(8, 0x00)]);
    }

    #[test]
    fn bubbled_gates_de_morgan() {
        // NAND(a, b) ≡ OR(¬a, ¬b)
        let nand = mk("gate.nand", json!({}));
        let or_neg = mk("gate.or", json!({"negateInputs": ["in0", "in1"]}));
        // NOR(a, b) ≡ AND(¬a, ¬b)
        let nor = mk("gate.nor", json!({}));
        let and_neg = mk("gate.and", json!({"negateInputs": ["in0", "in1"]}));
        // XNOR(a, b) ≡ XOR(¬a, b) (single bubble flips parity)
        let xnor = mk("gate.xnor", json!({}));
        let xor_neg = mk("gate.xor", json!({"negateInputs": ["in0"]}));
        for a in KNOWN {
            for b in KNOWN {
                let ins = [Value::from_bits(&[a]), Value::from_bits(&[b])];
                assert_eq!(
                    nand.eval(&refs(&ins)).unwrap(),
                    or_neg.eval(&refs(&ins)).unwrap(),
                    "De Morgan NAND at {a},{b}"
                );
                assert_eq!(
                    nor.eval(&refs(&ins)).unwrap(),
                    and_neg.eval(&refs(&ins)).unwrap(),
                    "De Morgan NOR at {a},{b}"
                );
                assert_eq!(
                    xnor.eval(&refs(&ins)).unwrap(),
                    xor_neg.eval(&refs(&ins)).unwrap(),
                    "XNOR ≡ XOR(¬a,b) at {a},{b}"
                );
            }
        }
        // Single bubble on AND: AND(a, ¬b).
        let and_b = mk("gate.and", json!({"negateInputs": ["in1"]}));
        let ins = [k(1, 1), k(1, 0)];
        assert_eq!(and_b.eval(&refs(&ins)).unwrap(), vec![k(1, 1)]);
        let ins = [k(1, 1), k(1, 1)];
        assert_eq!(and_b.eval(&refs(&ins)).unwrap(), vec![k(1, 0)]);
    }

    #[test]
    fn not_and_buffer() {
        let n = mk("gate.not", json!({"bitsize": 4}));
        let ins = [k(4, 0b1010)];
        assert_eq!(n.eval(&refs(&ins)).unwrap(), vec![k(4, 0b0101)]);
        let b = mk("gate.buffer", json!({"bitsize": 4}));
        assert_eq!(b.eval(&refs(&ins)).unwrap(), vec![k(4, 0b1010)]);
        // X passes through; Z halts naming the pin.
        let ins = [Value::x(4)];
        assert_eq!(n.eval(&refs(&ins)).unwrap(), vec![Value::x(4)]);
        let ins = [Value::z(4)];
        assert_eq!(n.eval(&refs(&ins)), Err(FloatingRead::at("in")));
    }

    // ---- Controlled buffer & tri-state contention --------------------

    #[test]
    fn controlled_buffer_states() {
        let cb = mk("wiring.controlled-buffer", json!({"bitsize": 8}));
        // Enabled: passthrough.
        let ins = [k(8, 0x5A), k(1, 1)];
        assert_eq!(cb.eval(&refs(&ins)).unwrap(), vec![k(8, 0x5A)]);
        // Disabled: output floats.
        let ins = [k(8, 0x5A), k(1, 0)];
        assert_eq!(cb.eval(&refs(&ins)).unwrap(), vec![Value::z(8)]);
        // en = X → output X.
        let ins = [k(8, 0x5A), Value::x(1)];
        assert_eq!(cb.eval(&refs(&ins)).unwrap(), vec![Value::x(8)]);
        // Z on data: consumed only while enabled (incl. en=X).
        for en in [k(1, 1), Value::x(1)] {
            let ins = [Value::z(8), en];
            assert_eq!(cb.eval(&refs(&ins)), Err(FloatingRead::at("in")));
        }
        let ins = [Value::z(8), k(1, 0)];
        assert!(cb.eval(&refs(&ins)).is_ok());
        // Z on enable: always consumed.
        let ins = [k(8, 0), Value::z(1)];
        assert_eq!(cb.eval(&refs(&ins)), Err(FloatingRead::at("en")));
    }

    #[test]
    fn tristate_bus_contention_is_x() {
        let a = mk("wiring.controlled-buffer", json!({"bitsize": 8}));
        let b = mk("wiring.controlled-buffer", json!({"bitsize": 8}));
        // Both enabled, disagreeing → contention merge on the net → X.
        let out_a = a.eval(&refs(&[k(8, 0xFF), k(1, 1)])).unwrap();
        let out_b = b.eval(&refs(&[k(8, 0x00), k(1, 1)])).unwrap();
        assert_eq!(
            Value::contention_merge(8, &[out_a[0].clone(), out_b[0].clone()]),
            Value::x(8)
        );
        // Both enabled, agreeing → no contention.
        let out_a = a.eval(&refs(&[k(8, 0xFF), k(1, 1)])).unwrap();
        let out_b = b.eval(&refs(&[k(8, 0xFF), k(1, 1)])).unwrap();
        assert_eq!(
            Value::contention_merge(8, &[out_a[0].clone(), out_b[0].clone()]),
            k(8, 0xFF)
        );
        // One disabled (drives Z): the other wins.
        let out_a = a.eval(&refs(&[k(8, 0xFF), k(1, 0)])).unwrap();
        let out_b = b.eval(&refs(&[k(8, 0x2A), k(1, 1)])).unwrap();
        assert_eq!(
            Value::contention_merge(8, &[out_a[0].clone(), out_b[0].clone()]),
            k(8, 0x2A)
        );
        // Both disabled: the bus idles at Z (legal — §4.1).
        let out_a = a.eval(&refs(&[k(8, 0xFF), k(1, 0)])).unwrap();
        let out_b = b.eval(&refs(&[k(8, 0x2A), k(1, 0)])).unwrap();
        assert_eq!(
            Value::contention_merge(8, &[out_a[0].clone(), out_b[0].clone()]),
            Value::z(8)
        );
    }

    // ---- Plexers -------------------------------------------------------

    #[test]
    fn mux_selects_and_ignores_unselected() {
        let m = mk("plexers.mux", json!({"bitsize": 8, "selectBits": 2}));
        let data = [k(8, 10), k(8, 20), k(8, 30), k(8, 40)];
        for i in 0..4u64 {
            let mut ins: Vec<Value> = data.to_vec();
            ins.push(k(2, i));
            assert_eq!(m.eval(&refs(&ins)).unwrap(), vec![k(8, 10 * (i + 1))]);
        }
        // Unselected inputs float: fine (not consumed).
        let ins = [Value::z(8), Value::z(8), k(8, 30), Value::z(8), k(2, 2)];
        assert_eq!(m.eval(&refs(&ins)).unwrap(), vec![k(8, 30)]);
        // Selected input floats: halt naming it.
        let ins = [k(8, 10), Value::z(8), k(8, 30), k(8, 40), k(2, 1)];
        assert_eq!(m.eval(&refs(&ins)), Err(FloatingRead::at("in1")));
        // Floating select: halt.
        let ins = [k(8, 10), k(8, 20), k(8, 30), k(8, 40), Value::z(2)];
        assert_eq!(m.eval(&refs(&ins)), Err(FloatingRead::at("sel")));
    }

    #[test]
    fn mux_x_select() {
        let m = mk("plexers.mux", json!({"bitsize": 8, "selectBits": 1}));
        // All data equal → that value even with X select.
        let ins = [k(8, 7), k(8, 7), Value::x(1)];
        assert_eq!(m.eval(&refs(&ins)).unwrap(), vec![k(8, 7)]);
        // Differing data → X.
        let ins = [k(8, 7), k(8, 9), Value::x(1)];
        assert_eq!(m.eval(&refs(&ins)).unwrap(), vec![Value::x(8)]);
        // X select consumes all data (conservative rule).
        let ins = [Value::z(8), k(8, 9), Value::x(1)];
        assert_eq!(m.eval(&refs(&ins)), Err(FloatingRead::at("in0")));
    }

    #[test]
    fn demux_and_decoder() {
        let d = mk("plexers.demux", json!({"bitsize": 4, "selectBits": 2}));
        let ins = [k(4, 0xB), k(2, 2)];
        assert_eq!(
            d.eval(&refs(&ins)).unwrap(),
            vec![k(4, 0), k(4, 0), k(4, 0xB), k(4, 0)]
        );
        let ins = [k(4, 0xB), Value::x(2)];
        assert_eq!(d.eval(&refs(&ins)).unwrap(), vec![Value::x(4); 4]);
        let ins = [Value::z(4), k(2, 0)];
        assert_eq!(d.eval(&refs(&ins)), Err(FloatingRead::at("in")));

        let dec = mk("plexers.decoder", json!({"inputBits": 3}));
        let ins = [k(3, 5)];
        let outs = dec.eval(&refs(&ins)).unwrap();
        assert_eq!(outs.len(), 8);
        assert_eq!(outs[5], k(1, 1));
        assert!(outs
            .iter()
            .enumerate()
            .all(|(i, o)| *o == k(1, (i == 5) as u64)));
        let ins = [Value::x(3)];
        assert_eq!(dec.eval(&refs(&ins)).unwrap(), vec![Value::x(1); 8]);
    }

    // ---- Arithmetic ----------------------------------------------------

    #[test]
    fn adder_subtractor() {
        let add = mk("arith.adder", json!({"bitsize": 32}));
        let ins = [k(32, 0xFFFF_FFFF), k(32, 1), k(1, 0)];
        assert_eq!(
            add.eval(&refs(&ins)).unwrap(),
            vec![k(32, 0), k(1, 1)] // wraps, carries out
        );
        let ins = [k(32, 0xFFFF_FFFF), k(32, 0xFFFF_FFFF), k(1, 1)];
        assert_eq!(
            add.eval(&refs(&ins)).unwrap(),
            vec![k(32, 0xFFFF_FFFF), k(1, 1)]
        );
        // Full-width (32-bit) adder with carry in/out chain.
        let ins = [k(32, 1), k(32, 0xFFFF_FFFF), k(1, 1)];
        assert_eq!(add.eval(&refs(&ins)).unwrap(), vec![k(32, 1), k(1, 1)]);
        // (Multi-limb arithmetic is exercised by the Value tests and by
        // the 32×32→64 multiplier; no component attr exceeds 32 bits.)
        // X propagation, Z consumption.
        let ins = [Value::x(32), k(32, 1), k(1, 0)];
        assert_eq!(
            add.eval(&refs(&ins)).unwrap(),
            vec![Value::x(32), Value::x(1)]
        );
        let ins = [k(32, 1), k(32, 1), Value::z(1)];
        assert_eq!(add.eval(&refs(&ins)), Err(FloatingRead::at("cin")));

        let sub = mk("arith.subtractor", json!({"bitsize": 8}));
        let ins = [k(8, 10), k(8, 3), k(1, 0)];
        assert_eq!(sub.eval(&refs(&ins)).unwrap(), vec![k(8, 7), k(1, 0)]);
        let ins = [k(8, 3), k(8, 10), k(1, 0)];
        assert_eq!(sub.eval(&refs(&ins)).unwrap(), vec![k(8, 249), k(1, 1)]);
        let ins = [k(8, 10), k(8, 10), k(1, 1)];
        assert_eq!(sub.eval(&refs(&ins)).unwrap(), vec![k(8, 0xFF), k(1, 1)]);
    }

    #[test]
    fn multiplier_divider() {
        let mul = mk("arith.multiplier", json!({"bitsize": 32}));
        let ins = [k(32, 0xFFFF), k(32, 0xFFFF)];
        assert_eq!(mul.eval(&refs(&ins)).unwrap(), vec![k(64, 0xFFFE_0001)]);

        let div = mk("arith.divider", json!({"bitsize": 8}));
        let ins = [k(8, 100), k(8, 7)];
        assert_eq!(div.eval(&refs(&ins)).unwrap(), vec![k(8, 14), k(8, 2)]);
        // Divide by zero → X, X (documented).
        let ins = [k(8, 100), k(8, 0)];
        assert_eq!(
            div.eval(&refs(&ins)).unwrap(),
            vec![Value::x(8), Value::x(8)]
        );
    }

    #[test]
    fn comparator_negator() {
        let cmp = mk("arith.comparator", json!({"bitsize": 16}));
        assert_eq!(
            cmp.eval(&refs(&[k(16, 5), k(16, 9)])).unwrap(),
            vec![k(1, 1), k(1, 0), k(1, 0)]
        );
        assert_eq!(
            cmp.eval(&refs(&[k(16, 9), k(16, 9)])).unwrap(),
            vec![k(1, 0), k(1, 1), k(1, 0)]
        );
        assert_eq!(
            cmp.eval(&refs(&[k(16, 9), k(16, 5)])).unwrap(),
            vec![k(1, 0), k(1, 0), k(1, 1)]
        );
        assert_eq!(
            cmp.eval(&refs(&[Value::x(16), k(16, 5)])).unwrap(),
            vec![Value::x(1), Value::x(1), Value::x(1)]
        );

        let neg = mk("arith.negator", json!({"bitsize": 8}));
        assert_eq!(neg.eval(&refs(&[k(8, 1)])).unwrap(), vec![k(8, 0xFF)]);
        assert_eq!(neg.eval(&refs(&[k(8, 0xFF)])).unwrap(), vec![k(8, 1)]);
    }

    #[test]
    fn shifter_modes() {
        let v = k(8, 0b1000_0001);
        let cases = [
            ("ll", 0b0000_0010),
            ("lr", 0b0100_0000),
            ("ar", 0b1100_0000),
            ("rl", 0b0000_0011),
            ("rr", 0b1100_0000),
        ];
        for (mode, expect) in cases {
            let sh = mk("arith.shifter", json!({"bitsize": 8, "shift": mode}));
            assert_eq!(
                sh.eval(&refs(&[v.clone(), k(2, 1)])).unwrap(),
                vec![k(8, expect)],
                "shift {mode}"
            );
        }
        let sh = mk("arith.shifter", json!({"bitsize": 8}));
        assert_eq!(
            sh.eval(&refs(&[v.clone(), Value::x(3)])).unwrap(),
            vec![Value::x(8)]
        );
        assert_eq!(
            sh.eval(&refs(&[v, Value::z(3)])),
            Err(FloatingRead::at("amt"))
        );
    }

    #[test]
    fn bit_extender() {
        let zx = mk("arith.bit-extender", json!({"inBits": 8, "outBits": 16}));
        assert_eq!(zx.eval(&refs(&[k(8, 0x81)])).unwrap(), vec![k(16, 0x0081)]);
        let sx = mk(
            "arith.bit-extender",
            json!({"inBits": 8, "outBits": 16, "mode": "sign"}),
        );
        assert_eq!(sx.eval(&refs(&[k(8, 0x81)])).unwrap(), vec![k(16, 0xFF81)]);
        assert_eq!(sx.eval(&refs(&[k(8, 0x71)])).unwrap(), vec![k(16, 0x0071)]);
        // X sign bit → X extension.
        let sx2 = mk(
            "arith.bit-extender",
            json!({"inBits": 1, "outBits": 4, "mode": "sign"}),
        );
        assert_eq!(sx2.eval(&refs(&[Value::x(1)])).unwrap(), vec![Value::x(4)]);
    }

    // ---- Splitter ------------------------------------------------------

    #[test]
    fn splitter_bus_to_splits_and_back() {
        // splits sorted by name: pin order is [bus, hi, lo].
        let sp = mk(
            "wiring.splitter",
            json!({"splits": {"lo": [0, 1, 2, 3], "hi": [4, 5, 6, 7]}}),
        );
        // Bus driven by others → splits driven from the bus.
        let nets = [k(8, 0xAB), Value::z(4), Value::z(4)];
        let out = sp.eval_splitter(&nets);
        assert_eq!(out[0], k(8, 0xAB));
        assert_eq!(out[1], k(4, 0xA)); // hi
        assert_eq!(out[2], k(4, 0xB)); // lo
                                       // Splits driven → bus assembled; each split also re-driven with its
                                       // resolved bits (so split→bus→split flows).
        let nets = [Value::z(8), k(4, 0xA), k(4, 0xB)];
        let out = sp.eval_splitter(&nets);
        assert_eq!(out[0], k(8, 0xAB));
        assert_eq!(out[1], k(4, 0xA));
        assert_eq!(out[2], k(4, 0xB));
        // Everything floating → drives Z (no-op in the net merge); no error.
        let nets = [Value::z(8), Value::z(4), Value::z(4)];
        let out = sp.eval_splitter(&nets);
        assert_eq!(out[0], Value::z(8));
        assert_eq!(out[1], Value::z(4));
    }

    #[test]
    fn splitter_contention_through_the_split() {
        let sp = mk(
            "wiring.splitter",
            json!({"splits": {"lo": [0, 1, 2, 3], "hi": [4, 5, 6, 7]}}),
        );
        // Bus driven 0x00 by others while lo is driven 0xF: the short makes
        // the low nibble X on the bus AND fed back onto lo.
        let nets = [k(8, 0x00), Value::z(4), k(4, 0xF)];
        let out = sp.eval_splitter(&nets);
        assert_eq!(
            out[0],
            Value::from_bits(&[
                Bit::X,
                Bit::X,
                Bit::X,
                Bit::X,
                Bit::Zero,
                Bit::Zero,
                Bit::Zero,
                Bit::Zero,
            ])
        );
        assert_eq!(out[2], Value::x(4)); // lo
                                         // hi undriven by others: gets the bus's (resolved) high nibble = 0.
        assert_eq!(out[1], k(4, 0x0));
    }

    #[test]
    fn splitter_bit_reversal_map() {
        // Array position = split-pin bit; value = bus bit index.
        let sp = mk("wiring.splitter", json!({"splits": {"rev": [3, 2, 1, 0]}}));
        let nets = [k(4, 0b1000), Value::z(4)];
        let out = sp.eval_splitter(&nets);
        assert_eq!(out[0], k(4, 0b1000));
        assert_eq!(out[1], k(4, 0b0001)); // rev bit0 ↔ bus bit3
    }

    // ---- Register ------------------------------------------------------

    fn reg() -> Behavior {
        mk("mem.register", json!({"bitsize": 8}))
    }

    fn reg_ins(d: Value, en: Value, rst: Value) -> [Value; 4] {
        [d, k(1, 1), en, rst] // clk=1 (engine calls rising_edge on the edge)
    }

    #[test]
    fn register_latch_hold_reset() {
        let mut r = reg();
        assert_eq!(r.eval(&[]).unwrap(), vec![k(8, 0)]); // powers on at 0
                                                         // Latch when enabled.
        r.rising_edge(&refs(&reg_ins(k(8, 42), k(1, 1), k(1, 0))))
            .unwrap();
        assert_eq!(r.eval(&[]).unwrap(), vec![k(8, 42)]);
        // Hold when disabled (D floats — not consumed).
        r.rising_edge(&refs(&reg_ins(Value::z(8), k(1, 0), k(1, 0))))
            .unwrap();
        assert_eq!(r.eval(&[]).unwrap(), vec![k(8, 42)]);
        // Synchronous reset wins over enable.
        r.rising_edge(&refs(&reg_ins(k(8, 99), k(1, 1), k(1, 1))))
            .unwrap();
        assert_eq!(r.eval(&[]).unwrap(), vec![k(8, 0)]);
    }

    #[test]
    fn register_floating_and_unknown_controls() {
        let mut r = reg();
        // D floats while enabled at the edge → halt naming the pin (§4.1).
        assert_eq!(
            r.rising_edge(&refs(&reg_ins(Value::z(8), k(1, 1), k(1, 0)))),
            Err(FloatingRead::at("d"))
        );
        // D floats but reset asserted → D irrelevant, no halt.
        r.rising_edge(&refs(&reg_ins(Value::z(8), k(1, 1), k(1, 1))))
            .unwrap();
        // Floating control inputs halt.
        assert_eq!(
            r.rising_edge(&refs(&reg_ins(k(8, 1), Value::z(1), k(1, 0)))),
            Err(FloatingRead::at("en"))
        );
        assert_eq!(
            r.rising_edge(&refs(&reg_ins(k(8, 1), k(1, 1), Value::z(1)))),
            Err(FloatingRead::at("rst"))
        );
        // Unknown enable → state unknown; unknown reset → state unknown.
        r.rising_edge(&refs(&reg_ins(k(8, 5), Value::x(1), k(1, 0))))
            .unwrap();
        assert_eq!(r.eval(&[]).unwrap(), vec![Value::x(8)]);
        r.rising_edge(&refs(&reg_ins(k(8, 5), k(1, 0), Value::x(1))))
            .unwrap();
        assert_eq!(r.eval(&[]).unwrap(), vec![Value::x(8)]);
        // ...but en=X with a floating D halts (D might be latched).
        assert_eq!(
            r.rising_edge(&refs(&reg_ins(Value::z(8), Value::x(1), k(1, 0)))),
            Err(FloatingRead::at("d"))
        );
    }

    // ---- RAM / ROM -------------------------------------------------------

    #[test]
    fn ram_write_read_and_floating_rules() {
        let mut ram = mk("mem.ram", json!({"bitsize": 8, "depth": 16}));
        assert!(ram.is_clocked());
        // Powers on zeroed; async read follows addr.
        assert_eq!(
            ram.eval(&refs(&[k(4, 5), k(8, 0), k(1, 0), k(1, 0)]))
                .unwrap(),
            vec![k(8, 0)]
        );
        // Write 77 @ 5 on the edge (ins order: addr, din, we, clk).
        ram.rising_edge(&refs(&[k(4, 5), k(8, 77), k(1, 1), k(1, 1)]))
            .unwrap();
        assert_eq!(
            ram.eval(&refs(&[k(4, 5), k(8, 0), k(1, 0), k(1, 0)]))
                .unwrap(),
            vec![k(8, 77)]
        );
        // we=0: no write.
        ram.rising_edge(&refs(&[k(4, 5), k(8, 99), k(1, 0), k(1, 1)]))
            .unwrap();
        assert_eq!(
            ram.eval(&refs(&[k(4, 5), k(8, 0), k(1, 0), k(1, 0)]))
                .unwrap(),
            vec![k(8, 77)]
        );
        // din floats during a write → halt; din floats with we=0 → fine.
        assert_eq!(
            ram.rising_edge(&refs(&[k(4, 5), Value::z(8), k(1, 1), k(1, 1)])),
            Err(FloatingRead::at("din"))
        );
        ram.rising_edge(&refs(&[k(4, 5), Value::z(8), k(1, 0), k(1, 1)]))
            .unwrap();
        // addr floats during read → halt (async read is always accessing).
        assert_eq!(
            ram.eval(&refs(&[Value::z(4), k(8, 0), k(1, 0), k(1, 0)])),
            Err(FloatingRead::at("addr"))
        );
        // X address reads X; we=X writes X.
        assert_eq!(
            ram.eval(&refs(&[Value::x(4), k(8, 0), k(1, 0), k(1, 0)]))
                .unwrap(),
            vec![Value::x(8)]
        );
        ram.rising_edge(&refs(&[k(4, 6), k(8, 42), Value::x(1), k(1, 1)]))
            .unwrap();
        assert_eq!(
            ram.eval(&refs(&[k(4, 6), k(8, 0), k(1, 0), k(1, 0)]))
                .unwrap(),
            vec![Value::x(8)]
        );
        // we floats at the edge → halt.
        assert_eq!(
            ram.rising_edge(&refs(&[k(4, 5), k(8, 1), Value::z(1), k(1, 1)])),
            Err(FloatingRead::at("we"))
        );
    }

    #[test]
    fn ram_past_end_address() {
        // depth 3 is rejected by validation (not a power of two); this
        // exercises the defensive path through the lenient constructor —
        // addr width 2 can address word 3, which does not exist.
        let mut ram = mk("mem.ram", json!({"bitsize": 8, "depth": 3}));
        assert_eq!(
            ram.eval(&refs(&[k(2, 3), k(8, 0), k(1, 0), k(1, 0)]))
                .unwrap(),
            vec![Value::x(8)] // read past end → X
        );
        ram.rising_edge(&refs(&[k(2, 3), k(8, 9), k(1, 1), k(1, 1)]))
            .unwrap(); // write dropped
        assert_eq!(
            ram.eval(&refs(&[k(2, 3), k(8, 0), k(1, 0), k(1, 0)]))
                .unwrap(),
            vec![Value::x(8)]
        );
    }

    #[test]
    fn memory_contents_and_autograder_access() {
        let ram = mk(
            "mem.ram",
            json!({"bitsize": 8, "depth": 4, "contents": "2-2a 7f"}),
        );
        assert_eq!(ram.memory_len(), Some(4));
        assert_eq!(ram.memory_word(0), Some(k(8, 0x2a)));
        assert_eq!(ram.memory_word(1), Some(k(8, 0x2a)));
        assert_eq!(ram.memory_word(2), Some(k(8, 0x7f)));
        assert_eq!(ram.memory_word(3), Some(k(8, 0)));
        // ROM reads via eval; autograder word access works the same.
        let rom = mk(
            "mem.rom",
            json!({"bitsize": 16, "depth": 4, "contents": "10"}),
        );
        assert_eq!(rom.memory_word(0), Some(k(16, 0x10)));
        assert_eq!(rom.eval(&refs(&[k(2, 0)])).unwrap(), vec![k(16, 0x10)]);
        assert_eq!(rom.eval(&refs(&[Value::x(2)])).unwrap(), vec![Value::x(16)]);
        assert_eq!(
            rom.eval(&refs(&[Value::z(2)])),
            Err(FloatingRead::at("addr"))
        );
        // Bulk image load (autoload / --load path).
        let mut ram = mk("mem.ram", json!({"bitsize": 8, "depth": 4}));
        ram.load_words(&[1, 2, 3, 4, 5]); // extra ignored
        assert_eq!(ram.memory_word(3), Some(k(8, 4)));
        ram.set_memory_word(1, k(8, 0xEE));
        assert_eq!(ram.memory_word(1), Some(k(8, 0xEE)));
    }

    // ---- Wiring / IO basics --------------------------------------------

    #[test]
    fn sources_sinks_and_poking() {
        // Constant.
        let c = mk("wiring.constant", json!({"bitsize": 8, "value": "a5"}));
        assert_eq!(c.eval(&[]).unwrap(), vec![k(8, 0xA5)]);

        // Clock mirrors the global phase.
        let mut clk = mk("wiring.clock", json!({}));
        assert_eq!(clk.eval(&[]).unwrap(), vec![k(1, 0)]);
        clk.set_phase(true);
        assert_eq!(clk.eval(&[]).unwrap(), vec![k(1, 1)]);

        // Input pin holds its poked value; output pin is a pure sink.
        let mut pin = mk("wiring.pin", json!({"bitsize": 8}));
        pin.set_pin_value(k(8, 0x3C));
        assert_eq!(pin.eval(&[]).unwrap(), vec![k(8, 0x3C)]);
        let opin = mk("wiring.pin", json!({"bitsize": 8, "isOutput": true}));
        assert_eq!(opin.eval(&[&k(8, 0xFF)]).unwrap(), vec![] as Vec<Value>);

        // Button.
        let mut btn = mk("io.button", json!({}));
        assert_eq!(btn.eval(&[]).unwrap(), vec![k(1, 0)]);
        btn.set_pressed(true);
        assert_eq!(btn.eval(&[]).unwrap(), vec![k(1, 1)]);

        // Probe/LED/hex display: observe only — a floating net shown on a
        // probe is legal (§4.1: idle buses display Z) and must not halt.
        for t in ["wiring.probe", "io.led", "io.hexdisplay"] {
            let p = mk(t, json!({"bitsize": 8}));
            let z = Value::z(8);
            assert_eq!(p.eval(&[&z]).unwrap(), vec![] as Vec<Value>);
        }

        // Subcircuits have no behavior (inlined at netlist build).
        let attrs = json!({"circuit": "alu"});
        let cfg = crate::components::config("subcircuit", attrs.as_object().unwrap()).unwrap();
        assert!(Behavior::new(&cfg).is_none());
        assert!(from_type_attrs("subcircuit", attrs.as_object().unwrap()).is_none());
    }

    // ---- Timing ----------------------------------------------------------

    #[test]
    fn timing_params_and_override() {
        let reg = mk("mem.register", json!({"bitsize": 32}));
        assert_eq!(
            reg.timing(),
            Timing {
                prop: T_CLK_TO_Q,
                setup: T_SETUP,
                hold: T_HOLD,
                access: 0
            }
        );
        let ram = mk("mem.ram", json!({}));
        assert_eq!(ram.timing().access, T_ACCESS);
        assert_eq!(ram.timing().setup, T_SETUP);
        let gate = mk("gate.and", json!({}));
        assert_eq!(gate.timing().prop, T_PD_GATE);
        let xor = mk("gate.xor", json!({}));
        assert_eq!(xor.timing().prop, T_PD_XOR);
        // Per-instance override replaces prop (§4.3).
        let gate = mk("gate.and", json!({"delay": 42}));
        assert_eq!(gate.timing().prop, 42);
        // Ideal parts have zero delay.
        let sp = mk("wiring.splitter", json!({"splits": {"a": [0]}}));
        assert_eq!(sp.timing().prop, 0);
    }
}
