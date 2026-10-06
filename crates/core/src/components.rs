//! Component registry: known type strings, pin *signatures* (name,
//! direction, width), and attribute validation (README §4 naming; DESIGN.md
//! §6; `docs/format-v2.md` §4).
//!
//! This table is the single source of truth for component *interfaces* —
//! the pins a component instance exposes, as a function of its `attrs`.
//! One code path ([`analyze`]) feeds both load-time validation (task B2,
//! strict, errors collected) and netlist construction (task B3, lenient,
//! defaults substituted), so the two can never drift apart.
//!
//! Only interfaces live here — no simulation behavior (task B4).

use std::collections::BTreeSet;

use serde_json::{Map, Value as Json};

use crate::api::{CompId, LoadError, LoadErrorKind};
use crate::value::Value;

/// Hard sanity caps (DESIGN.md §11 — corrupt files must not be able to
/// OOM the grader). Bitsize is capped at the course's word size (32;
/// nothing in the course is wider — the 64-bit multiplier *output* is a
/// derived pin width, not a `bitsize` attr). Memory depth is capped at
/// 2²⁰ words — far beyond the course's 64K address space, and small
/// enough that a max-depth RAM's state fits comfortably in the 2 GB
/// grader container (a `Value` is ~100 bytes of struct + heap).
pub const MAX_BITSIZE: u32 = 32;
pub const MAX_GATE_INPUTS: u32 = 64;
pub const MAX_SELECT_BITS: u32 = 8;
pub const MAX_MEM_DEPTH: u32 = 1 << 20;
pub const MAX_SPLIT_PINS: u32 = 64;

/// Every component type string the registry knows (sorted). Delay-table
/// validation (task B7) rejects table keys outside this list.
pub const KNOWN_TYPES: &[&str] = &[
    "arith.adder",
    "arith.bit-extender",
    "arith.comparator",
    "arith.divider",
    "arith.multiplier",
    "arith.negator",
    "arith.shifter",
    "arith.subtractor",
    "gate.and",
    "gate.buffer",
    "gate.nand",
    "gate.nor",
    "gate.not",
    "gate.or",
    "gate.xnor",
    "gate.xor",
    "io.button",
    "io.hexdisplay",
    "io.led",
    "mem.ram",
    "mem.register",
    "mem.rom",
    "plexers.decoder",
    "plexers.demux",
    "plexers.mux",
    "subcircuit",
    "wiring.clock",
    "wiring.constant",
    "wiring.controlled-buffer",
    "wiring.pin",
    "wiring.probe",
    "wiring.splitter",
];

/// Electrical direction of a pin (used for net driver/sink accounting).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinDir {
    In,
    Out,
    /// Bidirectional (splitter pins): may drive or consume depending on
    /// which side is driven — resolved dynamically by the engine.
    InOut,
}

// ---------------------------------------------------------------------------
// Typed component configuration (task B4)
//
// `analyze` parses `attrs` once and produces both the pin signatures and a
// typed [`CompKind`]; behavior construction (behavior.rs) consumes the
// typed form, so attribute parsing lives in exactly one place.
// ---------------------------------------------------------------------------

/// Gate function. `Nand`/`Nor`/`Xnor` are the base op with inverted output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateOp {
    And,
    Or,
    Xor,
    Nand,
    Nor,
    Xnor,
}

impl GateOp {
    /// The non-inverting fold op; `true` in the second slot when the output
    /// is inverted (NAND/NOR/XNOR).
    pub fn base(self) -> (GateOp, bool) {
        match self {
            GateOp::And | GateOp::Nand => (GateOp::And, self == GateOp::Nand),
            GateOp::Or | GateOp::Nor => (GateOp::Or, self == GateOp::Nor),
            GateOp::Xor | GateOp::Xnor => (GateOp::Xor, self == GateOp::Xnor),
        }
    }
}

/// Shifter mode (`attrs.shift`, DESIGN.md §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShiftMode {
    LogicalLeft,
    LogicalRight,
    ArithRight,
    RotateLeft,
    RotateRight,
}

/// Bit-extender fill mode (`attrs.mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtendMode {
    Zero,
    Sign,
}

/// A component's typed configuration, parsed from `attrs` by [`analyze`]
/// (leniently: invalid values fall back to the same defaults the pin
/// signatures use, since netlisting runs only after validation passed).
#[derive(Debug, Clone, PartialEq)]
pub enum CompKind {
    Not {
        bitsize: u32,
    },
    Buffer {
        bitsize: u32,
    },
    Gate {
        op: GateOp,
        bitsize: u32,
        inputs: u32,
        negate_inputs: Vec<String>,
    },
    ControlledBuffer {
        bitsize: u32,
    },
    Pin {
        bitsize: u32,
        is_output: bool,
    },
    Constant {
        bitsize: u32,
        value: Value,
    },
    Clock,
    /// Split pin name → bus bit indices (array position = split-pin bit),
    /// sorted by pin name; `bus_width` covers the highest mapped bit + 1.
    Splitter {
        splits: Vec<(String, Vec<u32>)>,
        bus_width: u32,
    },
    Probe {
        bitsize: u32,
    },
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
    Comparator {
        bitsize: u32,
    },
    Negator {
        bitsize: u32,
    },
    Shifter {
        bitsize: u32,
        mode: ShiftMode,
    },
    BitExtender {
        in_bits: u32,
        out_bits: u32,
        mode: ExtendMode,
    },
    Register {
        bitsize: u32,
    },
    Ram {
        bitsize: u32,
        depth: u32,
        autoload: Option<String>,
        contents: Option<String>,
    },
    Rom {
        bitsize: u32,
        depth: u32,
        autoload: Option<String>,
        contents: Option<String>,
    },
    Subcircuit {
        circuit: String,
    },
    Button,
    Led {
        bitsize: u32,
    },
    HexDisplay {
        bitsize: u32,
    },
}

/// Full typed configuration: kind + per-instance delay override
/// (`attrs.delay`, DESIGN.md §4.3 — `None` = use the delay table, task B7).
#[derive(Debug, Clone, PartialEq)]
pub struct CompConfig {
    pub kind: CompKind,
    pub delay: Option<u64>,
}

/// A component pin's interface: name, direction, and width in bits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinSig {
    pub name: String,
    pub dir: PinDir,
    pub width: u32,
}

impl PinSig {
    fn i(name: impl Into<String>, width: u32) -> Self {
        PinSig {
            name: name.into(),
            dir: PinDir::In,
            width,
        }
    }
    fn o(name: impl Into<String>, width: u32) -> Self {
        PinSig {
            name: name.into(),
            dir: PinDir::Out,
            width,
        }
    }
    fn io(name: impl Into<String>, width: u32) -> Self {
        PinSig {
            name: name.into(),
            dir: PinDir::InOut,
            width,
        }
    }
}

/// Bits needed to address `n` words (≥ 1).
fn addr_width(depth: u32) -> u32 {
    (if depth <= 1 {
        0
    } else {
        u32::BITS - (depth - 1).leading_zeros()
    })
    .max(1)
}

/// Helper that accumulates attribute issues for one component. Issues are
/// plain messages (no `LoadError` plumbing); the caller wraps them.
struct AttrCheck<'a> {
    attrs: &'a Map<String, Json>,
    allowed: &'a [&'a str],
    issues: Vec<String>,
}

impl<'a> AttrCheck<'a> {
    fn new(attrs: &'a Map<String, Json>, allowed: &'a [&'a str]) -> Self {
        AttrCheck {
            attrs,
            allowed,
            issues: Vec::new(),
        }
    }

    /// Integer attribute with default and inclusive range.
    fn uint(&mut self, name: &str, default: u32, min: u32, max: u32) -> u32 {
        match self.attrs.get(name) {
            None => default,
            Some(Json::Number(n)) => match n.as_u64().and_then(|v| u32::try_from(v).ok()) {
                Some(v) if (min..=max).contains(&v) => v,
                Some(v) => {
                    self.issues
                        .push(format!("attr '{name}' = {v} out of range {min}..={max}"));
                    default
                }
                None => {
                    self.issues
                        .push(format!("attr '{name}' must be an unsigned integer"));
                    default
                }
            },
            Some(other) => {
                self.issues.push(format!(
                    "attr '{name}' must be an unsigned integer, got {other}"
                ));
                default
            }
        }
    }

    fn bitsize(&mut self, default: u32) -> u32 {
        self.uint("bitsize", default, 1, MAX_BITSIZE)
    }

    fn boolean(&mut self, name: &str, default: bool) -> bool {
        match self.attrs.get(name) {
            None => default,
            Some(Json::Bool(b)) => *b,
            Some(other) => {
                self.issues
                    .push(format!("attr '{name}' must be a boolean, got {other}"));
                default
            }
        }
    }

    /// Optional string (null or absent → None).
    fn opt_string(&mut self, name: &str) -> Option<String> {
        match self.attrs.get(name) {
            None | Some(Json::Null) => None,
            Some(Json::String(s)) => Some(s.clone()),
            Some(other) => {
                self.issues.push(format!(
                    "attr '{name}' must be a string or null, got {other}"
                ));
                None
            }
        }
    }

    fn string(&mut self, name: &str, default: &str) -> String {
        match self.attrs.get(name) {
            None => default.to_string(),
            Some(Json::String(s)) => s.clone(),
            Some(other) => {
                self.issues
                    .push(format!("attr '{name}' must be a string, got {other}"));
                default.to_string()
            }
        }
    }

    fn enumeration(&mut self, name: &str, choices: &[&str], default: &str) -> String {
        let v = self.string(name, default);
        if !choices.contains(&v.as_str()) {
            self.issues.push(format!(
                "attr '{name}' must be one of {choices:?}, got '{v}'"
            ));
            return default.to_string();
        }
        v
    }

    /// List of strings (e.g. `negateInputs`).
    fn string_list(&mut self, name: &str) -> Vec<String> {
        match self.attrs.get(name) {
            None => Vec::new(),
            Some(Json::Array(items)) => {
                let mut out = Vec::with_capacity(items.len());
                for it in items {
                    match it.as_str() {
                        Some(s) => out.push(s.to_string()),
                        None => self
                            .issues
                            .push(format!("attr '{name}' entries must be strings, got {it}")),
                    }
                }
                out
            }
            Some(other) => {
                self.issues.push(format!(
                    "attr '{name}' must be an array of strings, got {other}"
                ));
                Vec::new()
            }
        }
    }

    /// Per-instance delay override: null or non-negative integer.
    fn delay(&mut self) {
        match self.attrs.get("delay") {
            None | Some(Json::Null) => {}
            Some(Json::Number(n)) if n.as_u64().is_some() => {}
            Some(other) => self.issues.push(format!(
                "attr 'delay' must be null or a non-negative integer, got {other}"
            )),
        }
    }

    /// Every attribute key must be known — a typo'd attr name is an error,
    /// not silently ignored.
    fn finish(&mut self) {
        for key in self.attrs.keys() {
            if !self.allowed.contains(&key.as_str()) {
                self.issues
                    .push(format!("unknown attr '{key}' for this component type"));
            }
        }
    }
}

const GATE_ATTRS: &[&str] = &["bitsize", "delay"];

/// Analyze a component instance: validate its attrs, compute its pin
/// signatures, and produce its typed configuration. Returns `None` for an
/// unknown type string (with an issue recorded). On invalid attrs, issues
/// are recorded and signatures/config use defaults substituted so
/// downstream resolution still works.
fn analyze(type_: &str, attrs: &Map<String, Json>) -> Option<(Vec<PinSig>, Vec<String>, CompKind)> {
    let (pins, c, kind) = match type_ {
        "gate.not" | "gate.buffer" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
            c.delay();
            c.finish();
            let kind = if type_ == "gate.not" {
                CompKind::Not { bitsize: b }
            } else {
                CompKind::Buffer { bitsize: b }
            };
            (vec![PinSig::i("in", b), PinSig::o("out", b)], c, kind)
        }
        "gate.and" | "gate.or" | "gate.xor" | "gate.nand" | "gate.nor" | "gate.xnor" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "inputs", "negateInputs", "delay"]);
            let b = c.bitsize(1);
            let inputs = c.uint("inputs", 2, 2, MAX_GATE_INPUTS);
            let negate = c.string_list("negateInputs");
            c.delay();
            c.finish();
            let mut pins: Vec<PinSig> = (0..inputs)
                .map(|i| PinSig::i(format!("in{i}"), b))
                .collect();
            pins.push(PinSig::o("out", b));
            let names: BTreeSet<&str> = pins.iter().map(|p| p.name.as_str()).collect();
            for name in &negate {
                if !names.contains(name.as_str()) || name == "out" {
                    c_issue(
                        &mut c,
                        format!("negateInputs entry '{name}' is not one of its input pins"),
                    );
                }
            }
            let op = match type_ {
                "gate.and" => GateOp::And,
                "gate.or" => GateOp::Or,
                "gate.xor" => GateOp::Xor,
                "gate.nand" => GateOp::Nand,
                "gate.nor" => GateOp::Nor,
                _ => GateOp::Xnor,
            };
            let kind = CompKind::Gate {
                op,
                bitsize: b,
                inputs,
                negate_inputs: negate,
            };
            (pins, c, kind)
        }
        "wiring.controlled-buffer" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
            c.delay();
            c.finish();
            (
                vec![PinSig::i("in", b), PinSig::i("en", 1), PinSig::o("out", b)],
                c,
                CompKind::ControlledBuffer { bitsize: b },
            )
        }
        // A pin's direction is from the perspective of the circuit that
        // contains it: an input pin (isOutput=false) drives its net; an
        // output pin consumes.
        "wiring.pin" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "isOutput", "radix", "delay"]);
            let b = c.bitsize(1);
            let is_output = c.boolean("isOutput", false);
            c.enumeration("radix", &["unsigned", "signed", "hex"], "unsigned");
            c.finish();
            let dir = if is_output { PinDir::In } else { PinDir::Out };
            (
                vec![PinSig {
                    name: "pin".into(),
                    dir,
                    width: b,
                }],
                c,
                CompKind::Pin {
                    bitsize: b,
                    is_output,
                },
            )
        }
        "wiring.constant" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "value", "delay"]);
            let b = c.bitsize(1);
            let value = c.string("value", "0");
            c.delay();
            c.finish();
            let parsed = match Value::from_hex_masks(b, &value, "", "") {
                Ok(v) => v,
                Err(e) => {
                    c_issue(&mut c, format!("attr 'value': {e}"));
                    Value::zero(b)
                }
            };
            (
                vec![PinSig::o("out", b)],
                c,
                CompKind::Constant {
                    bitsize: b,
                    value: parsed,
                },
            )
        }
        "wiring.clock" => {
            let mut c = AttrCheck::new(attrs, &["delay"]);
            c.finish();
            (vec![PinSig::o("out", 1)], c, CompKind::Clock)
        }
        // Splitter pins are bidirectional (InOut): which side drives is
        // resolved dynamically (DESIGN.md §6 "arbitrary bit mapping — the
        // bus plumbing").
        "wiring.splitter" => {
            let mut c = AttrCheck::new(attrs, &["splits", "delay"]);
            c.delay();
            let splits = match attrs.get("splits") {
                None => {
                    c_issue(&mut c, "splitter requires attr 'splits'".to_string());
                    Map::new()
                }
                Some(Json::Object(m)) => m.clone(),
                Some(other) => {
                    c_issue(
                        &mut c,
                        format!(
                            "attr 'splits' must be an object mapping pin names to bit-index arrays, got {other}"
                        ),
                    );
                    Map::new()
                }
            };
            c.finish();
            // Map iteration is sorted by pin name (BTreeMap) — deterministic.
            let mut split_cfgs: Vec<(String, Vec<u32>)> = Vec::new();
            let mut seen: Vec<u32> = Vec::new();
            for (name, bits) in &splits {
                let mut idxs: Vec<u32> = Vec::new();
                match bits {
                    Json::Array(items) if !items.is_empty() => {
                        for it in items {
                            match it.as_u64().and_then(|v| u32::try_from(v).ok()) {
                                Some(b) if b < MAX_BITSIZE => {
                                    idxs.push(b);
                                    seen.push(b);
                                }
                                _ => c_issue(
                                    &mut c,
                                    format!("splits entry '{name}' has invalid bit index {it}"),
                                ),
                            }
                        }
                    }
                    _ => c_issue(
                        &mut c,
                        format!("splits entry '{name}' must be a non-empty array of bit indices"),
                    ),
                }
                split_cfgs.push((name.clone(), idxs));
            }
            if splits.len() as u32 > MAX_SPLIT_PINS {
                c_issue(
                    &mut c,
                    format!("too many split pins (max {MAX_SPLIT_PINS})"),
                );
            }
            let mut sorted = seen.clone();
            sorted.sort_unstable();
            for (i, &b) in sorted.iter().enumerate() {
                if b != i as u32 {
                    c_issue(
                        &mut c,
                        "splits must cover every bus bit exactly once (bit missing or duplicated)"
                            .to_string(),
                    );
                    break;
                }
            }
            let bus_width = sorted.last().map_or(0, |m| m + 1);
            let mut sigs = vec![PinSig::io("bus", bus_width)];
            sigs.extend(
                split_cfgs
                    .iter()
                    .map(|(n, idxs)| PinSig::io(n.clone(), idxs.len() as u32)),
            );
            (
                sigs,
                c,
                CompKind::Splitter {
                    splits: split_cfgs,
                    bus_width,
                },
            )
        }
        "wiring.probe" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "radix", "delay"]);
            let b = c.bitsize(1);
            c.enumeration("radix", &["unsigned", "signed", "hex"], "unsigned");
            c.finish();
            (vec![PinSig::i("in", b)], c, CompKind::Probe { bitsize: b })
        }
        "plexers.mux" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "selectBits", "delay"]);
            let b = c.bitsize(1);
            let sel = c.uint("selectBits", 1, 1, MAX_SELECT_BITS);
            c.delay();
            c.finish();
            let mut pins: Vec<PinSig> = (0..(1u32 << sel))
                .map(|i| PinSig::i(format!("in{i}"), b))
                .collect();
            pins.push(PinSig::i("sel", sel));
            pins.push(PinSig::o("out", b));
            (
                pins,
                c,
                CompKind::Mux {
                    bitsize: b,
                    select_bits: sel,
                },
            )
        }
        "plexers.demux" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "selectBits", "delay"]);
            let b = c.bitsize(1);
            let sel = c.uint("selectBits", 1, 1, MAX_SELECT_BITS);
            c.delay();
            c.finish();
            let mut pins = vec![PinSig::i("in", b), PinSig::i("sel", sel)];
            pins.extend((0..(1u32 << sel)).map(|i| PinSig::o(format!("out{i}"), b)));
            (
                pins,
                c,
                CompKind::Demux {
                    bitsize: b,
                    select_bits: sel,
                },
            )
        }
        "plexers.decoder" => {
            let mut c = AttrCheck::new(attrs, &["inputBits", "delay"]);
            let bits = c.uint("inputBits", 2, 1, MAX_SELECT_BITS);
            c.delay();
            c.finish();
            let mut pins = vec![PinSig::i("in", bits)];
            pins.extend((0..(1u32 << bits)).map(|i| PinSig::o(format!("out{i}"), 1)));
            (pins, c, CompKind::Decoder { input_bits: bits })
        }
        "arith.adder" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
            c.delay();
            c.finish();
            (
                vec![
                    PinSig::i("a", b),
                    PinSig::i("b", b),
                    PinSig::i("cin", 1),
                    PinSig::o("out", b),
                    PinSig::o("cout", 1),
                ],
                c,
                CompKind::Adder { bitsize: b },
            )
        }
        "arith.subtractor" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
            c.delay();
            c.finish();
            (
                vec![
                    PinSig::i("a", b),
                    PinSig::i("b", b),
                    PinSig::i("bin", 1),
                    PinSig::o("out", b),
                    PinSig::o("bout", 1),
                ],
                c,
                CompKind::Subtractor { bitsize: b },
            )
        }
        "arith.multiplier" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
            c.delay();
            c.finish();
            (
                vec![
                    PinSig::i("a", b),
                    PinSig::i("b", b),
                    PinSig::o("out", 2 * b),
                ],
                c,
                CompKind::Multiplier { bitsize: b },
            )
        }
        "arith.divider" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
            c.delay();
            c.finish();
            (
                vec![
                    PinSig::i("a", b),
                    PinSig::i("b", b),
                    PinSig::o("quot", b),
                    PinSig::o("rem", b),
                ],
                c,
                CompKind::Divider { bitsize: b },
            )
        }
        "arith.comparator" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
            c.delay();
            c.finish();
            (
                vec![
                    PinSig::i("a", b),
                    PinSig::i("b", b),
                    PinSig::o("lt", 1),
                    PinSig::o("eq", 1),
                    PinSig::o("gt", 1),
                ],
                c,
                CompKind::Comparator { bitsize: b },
            )
        }
        "arith.negator" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
            c.delay();
            c.finish();
            (
                vec![PinSig::i("in", b), PinSig::o("out", b)],
                c,
                CompKind::Negator { bitsize: b },
            )
        }
        "arith.shifter" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "shift", "delay"]);
            let b = c.bitsize(1);
            let shift = c.enumeration("shift", &["ll", "lr", "ar", "rl", "rr"], "ll");
            c.delay();
            c.finish();
            let mode = match shift.as_str() {
                "lr" => ShiftMode::LogicalRight,
                "ar" => ShiftMode::ArithRight,
                "rl" => ShiftMode::RotateLeft,
                "rr" => ShiftMode::RotateRight,
                _ => ShiftMode::LogicalLeft,
            };
            (
                vec![
                    PinSig::i("in", b),
                    PinSig::i("amt", addr_width(b)),
                    PinSig::o("out", b),
                ],
                c,
                CompKind::Shifter { bitsize: b, mode },
            )
        }
        "arith.bit-extender" => {
            let mut c = AttrCheck::new(attrs, &["inBits", "outBits", "mode", "delay"]);
            let in_bits = c.uint("inBits", 8, 1, MAX_BITSIZE);
            let out_bits = c.uint("outBits", 16, 1, MAX_BITSIZE);
            let mode = c.enumeration("mode", &["zero", "sign"], "zero");
            c.delay();
            c.finish();
            if out_bits <= in_bits {
                c_issue(
                    &mut c,
                    format!("bit-extender requires outBits ({out_bits}) > inBits ({in_bits})"),
                );
            }
            (
                vec![PinSig::i("in", in_bits), PinSig::o("out", out_bits)],
                c,
                CompKind::BitExtender {
                    in_bits,
                    out_bits,
                    mode: if mode == "sign" {
                        ExtendMode::Sign
                    } else {
                        ExtendMode::Zero
                    },
                },
            )
        }
        "mem.register" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
            c.delay();
            c.finish();
            (
                vec![
                    PinSig::i("d", b),
                    PinSig::i("clk", 1),
                    PinSig::i("en", 1),
                    PinSig::i("rst", 1),
                    PinSig::o("q", b),
                ],
                c,
                CompKind::Register { bitsize: b },
            )
        }
        "mem.ram" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "depth", "autoload", "contents", "delay"],
            );
            let b = c.bitsize(1);
            let depth = c.uint("depth", 256, 1, MAX_MEM_DEPTH);
            let autoload = c.opt_string("autoload");
            let contents = c.opt_string("contents");
            c.delay();
            c.finish();
            if !depth.is_power_of_two() {
                c_issue(&mut c, format!("depth ({depth}) must be a power of two"));
            }
            if let Some(contents) = &contents {
                if let Err(e) = crate::format::rle::parse(contents, MAX_MEM_DEPTH as usize) {
                    c_issue(&mut c, format!("attr 'contents': {e}"));
                }
            }
            (
                vec![
                    PinSig::i("addr", addr_width(depth)),
                    PinSig::i("din", b),
                    PinSig::o("dout", b),
                    PinSig::i("we", 1),
                    PinSig::i("clk", 1),
                ],
                c,
                CompKind::Ram {
                    bitsize: b,
                    depth,
                    autoload,
                    contents,
                },
            )
        }
        "mem.rom" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "depth", "autoload", "contents", "delay"],
            );
            let b = c.bitsize(1);
            let depth = c.uint("depth", 256, 1, MAX_MEM_DEPTH);
            let autoload = c.opt_string("autoload");
            let contents = c.opt_string("contents");
            c.delay();
            c.finish();
            if !depth.is_power_of_two() {
                c_issue(&mut c, format!("depth ({depth}) must be a power of two"));
            }
            if let Some(contents) = &contents {
                if let Err(e) = crate::format::rle::parse(contents, MAX_MEM_DEPTH as usize) {
                    c_issue(&mut c, format!("attr 'contents': {e}"));
                }
            }
            (
                vec![PinSig::i("addr", addr_width(depth)), PinSig::o("out", b)],
                c,
                CompKind::Rom {
                    bitsize: b,
                    depth,
                    autoload,
                    contents,
                },
            )
        }
        "subcircuit" => {
            let mut c = AttrCheck::new(attrs, &["circuit"]);
            let circuit = match attrs.get("circuit") {
                Some(Json::String(s)) => s.clone(),
                other => {
                    c_issue(
                        &mut c,
                        format!(
                            "subcircuit requires a string attr 'circuit', got {}",
                            other.map_or("nothing".to_string(), |o| o.to_string())
                        ),
                    );
                    String::new()
                }
            };
            c.finish();
            // Pins come from the referenced circuit's pin components;
            // callers with document context resolve them.
            (Vec::new(), c, CompKind::Subcircuit { circuit })
        }
        "io.button" => {
            let mut c = AttrCheck::new(attrs, &["delay"]);
            c.finish();
            (vec![PinSig::o("out", 1)], c, CompKind::Button)
        }
        "io.led" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
            c.finish();
            (vec![PinSig::i("in", b)], c, CompKind::Led { bitsize: b })
        }
        "io.hexdisplay" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(4);
            c.finish();
            (
                vec![PinSig::i("in", b)],
                c,
                CompKind::HexDisplay { bitsize: b },
            )
        }
        _ => return None,
    };
    Some((pins, c.issues, kind))
}

fn c_issue(c: &mut AttrCheck, message: String) {
    c.issues.push(message);
}

/// Pin signatures for a component instance (lenient: invalid attrs fall
/// back to defaults). `None` = unknown type string. Used by the netlist
/// builder, which runs after validation has already reported any issues.
pub fn pin_sigs(type_: &str, attrs: &Map<String, Json>) -> Option<Vec<PinSig>> {
    analyze(type_, attrs).map(|(sigs, _, _)| sigs)
}

/// Typed configuration for behavior construction (task B4), from the same
/// single parse as [`pin_sigs`]. `None` = unknown type string.
pub fn config(type_: &str, attrs: &Map<String, Json>) -> Option<CompConfig> {
    let delay = match attrs.get("delay") {
        Some(Json::Number(n)) => n.as_u64(),
        _ => None,
    };
    analyze(type_, attrs).map(|(_, _, kind)| CompConfig { kind, delay })
}

/// Validate a component's attrs and return its pin signatures. Returns
/// `None` for an unknown type string (error recorded); pin-name checks on
/// wires connected to such a component are skipped by the caller.
pub fn validate_component(
    circuit: &str,
    comp_idx: usize,
    comp_id: &str,
    type_: &str,
    attrs: &Map<String, Json>,
    errors: &mut Vec<LoadError>,
) -> Option<Vec<PinSig>> {
    match analyze(type_, attrs) {
        None => {
            errors.push(LoadError {
                kind: LoadErrorKind::Other,
                message: format!("component '{comp_id}': unknown component type '{type_}'"),
                circuit: circuit.to_string(),
                comp_id: Some(CompId(comp_idx as u32)),
                wire_idx: None,
            });
            None
        }
        Some((sigs, issues, _)) => {
            for message in issues {
                errors.push(LoadError {
                    kind: LoadErrorKind::Other,
                    message: format!("component '{comp_id}': {message}"),
                    circuit: circuit.to_string(),
                    comp_id: Some(CompId(comp_idx as u32)),
                    wire_idx: None,
                });
            }
            Some(sigs)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pins(type_: &str, attrs: Json) -> (Option<Vec<String>>, Vec<LoadError>) {
        let mut errors = Vec::new();
        let attrs = attrs.as_object().unwrap().clone();
        let p = validate_component("main", 0, "c0", type_, &attrs, &mut errors);
        (p.map(|v| v.into_iter().map(|s| s.name).collect()), errors)
    }

    #[test]
    fn gate_pin_names_and_negation() {
        let (p, e) = pins("gate.and", json!({"inputs": 3, "negateInputs": ["in2"]}));
        assert_eq!(p.unwrap(), vec!["in0", "in1", "in2", "out"]);
        assert!(e.is_empty());

        // Negating a non-existent input is an error.
        let (_, e) = pins("gate.and", json!({"inputs": 2, "negateInputs": ["in2"]}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("negateInputs"));

        // Defaults: 2 inputs, 1 bit.
        let (p, e) = pins("gate.xor", json!({}));
        assert_eq!(p.unwrap(), vec!["in0", "in1", "out"]);
        assert!(e.is_empty());
    }

    #[test]
    fn attr_type_and_range_errors() {
        let (_, e) = pins("gate.and", json!({"inputs": "lots"}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("unsigned integer"));

        let (_, e) = pins("gate.and", json!({"inputs": 1}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("out of range"));

        let (_, e) = pins("gate.and", json!({"bitszize": 8}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("unknown attr"));

        let (_, e) = pins("mem.register", json!({"delay": "fast"}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("delay"));
    }

    #[test]
    fn splitter_validation() {
        let (p, e) = pins(
            "wiring.splitter",
            json!({"splits": {"lo": [0, 1, 2, 3], "hi": [4, 5, 6, 7]}}),
        );
        assert!(e.is_empty());
        // Split pin names iterate in sorted (map) order — deterministic.
        assert_eq!(p.unwrap(), vec!["bus", "hi", "lo"]);

        // Gap in coverage.
        let (_, e) = pins(
            "wiring.splitter",
            json!({"splits": {"lo": [0, 1], "hi": [3]}}),
        );
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("exactly once"));

        // Duplicated bit.
        let (_, e) = pins(
            "wiring.splitter",
            json!({"splits": {"a": [0, 1], "b": [1]}}),
        );
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("exactly once"));
    }

    #[test]
    fn splitter_widths() {
        let attrs = json!({"splits": {"lo": [0, 1, 2, 3], "hi": [4, 5, 6, 7]}});
        let sigs = pin_sigs("wiring.splitter", attrs.as_object().unwrap()).unwrap();
        let widths: Vec<(&str, u32)> = sigs.iter().map(|s| (s.name.as_str(), s.width)).collect();
        assert_eq!(widths, vec![("bus", 8), ("hi", 4), ("lo", 4)]);
        assert!(sigs.iter().all(|s| s.dir == PinDir::InOut));
    }

    #[test]
    fn memory_contents_checked() {
        let (_, e) = pins("mem.ram", json!({"contents": "3-0f 12"}));
        assert!(e.is_empty());
        let (_, e) = pins("mem.ram", json!({"contents": "3-0f-2"}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("contents"));
    }

    #[test]
    fn memory_depth_must_be_power_of_two() {
        for t in ["mem.ram", "mem.rom"] {
            let (_, e) = pins(t, json!({"depth": 3}));
            assert_eq!(e.len(), 1);
            assert!(e[0].message.contains("power of two"));
            let (_, e) = pins(t, json!({"depth": 1024}));
            assert!(e.is_empty());
            let (_, e) = pins(t, json!({"depth": 1}));
            assert!(e.is_empty()); // 2^0 is a power of two
        }
    }

    #[test]
    fn plexer_pin_counts() {
        let (p, _) = pins("plexers.mux", json!({"selectBits": 2}));
        assert_eq!(p.unwrap(), vec!["in0", "in1", "in2", "in3", "sel", "out"]);
        let (p, _) = pins("plexers.demux", json!({"selectBits": 1}));
        assert_eq!(p.unwrap(), vec!["in", "sel", "out0", "out1"]);
        let (p, _) = pins("plexers.decoder", json!({"inputBits": 3}));
        assert_eq!(p.unwrap().len(), 1 + 8);
    }

    fn get<'a>(sigs: &'a [PinSig], n: &str) -> &'a PinSig {
        sigs.iter().find(|s| s.name == n).unwrap()
    }

    #[test]
    fn widths_and_directions() {
        let sigs = |t: &str, a: Json| pin_sigs(t, a.as_object().unwrap()).unwrap();

        // RAM: addr width from depth, port widths and directions.
        let ram = sigs("mem.ram", json!({"bitsize": 32, "depth": 65536}));
        assert_eq!(get(&ram, "addr").width, 16);
        assert_eq!(get(&ram, "din").width, 32);
        assert_eq!(get(&ram, "dout").dir, PinDir::Out);
        assert_eq!(get(&ram, "we").width, 1);

        // Multiplier output is double-width.
        let mul = sigs("arith.multiplier", json!({"bitsize": 32}));
        assert_eq!(get(&mul, "out").width, 64);

        // Shifter amount width is the address width of the data width.
        let sh = sigs("arith.shifter", json!({"bitsize": 32}));
        assert_eq!(get(&sh, "amt").width, 5);

        // Input pin drives; output pin consumes.
        let pin_in = sigs("wiring.pin", json!({}));
        assert_eq!(pin_in[0].dir, PinDir::Out);
        let pin_out = sigs("wiring.pin", json!({"isOutput": true}));
        assert_eq!(pin_out[0].dir, PinDir::In);

        // Register.
        let reg = sigs("mem.register", json!({"bitsize": 32}));
        assert_eq!(get(&reg, "q").dir, PinDir::Out);
        assert_eq!(get(&reg, "clk").width, 1);
    }

    #[test]
    fn unknown_type() {
        let (p, e) = pins("gate.magic", json!({}));
        assert!(p.is_none());
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("unknown component type"));
    }

    #[test]
    fn constant_value_must_fit() {
        let (_, e) = pins("wiring.constant", json!({"bitsize": 4, "value": "ff"}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("value"));
        let (_, e) = pins("wiring.constant", json!({"bitsize": 8, "value": "ff"}));
        assert!(e.is_empty());
    }
}
