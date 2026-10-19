//! Component registry: known type strings, pin *signatures* (name,
//! direction, width), and attribute validation (README §4 naming; DESIGN.md
//! §6; `docs/format-v2.md` §4).
//!
//! This table is the single source of truth for component *interfaces* —
//! the pins a component instance exposes, as a function of its `attrs`.
//! One code path (`analyze`) feeds both load-time validation (task B2,
//! strict, errors collected) and netlist construction (task B3, lenient,
//! defaults substituted), so the two can never drift apart.
//!
//! Only interfaces live here — no simulation behavior (task B4).

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
/// Max inputs on a multi-input gate (`inputs` attr).
/// Gate input cap (UI_OVERHAUL §24: the palette stops at 32).
pub const MAX_GATE_INPUTS: u32 = 32;
/// Max select bits on mux/demux (`selectBits`) and input bits on decoder
/// (`inputBits`).
pub const MAX_SELECT_BITS: u32 = 8;
/// Max memory depth in words (`depth` attr on RAM/ROM).
pub const MAX_MEM_DEPTH: u32 = 1 << 20;
/// Max split pins on a splitter.
pub const MAX_SPLIT_PINS: u32 = 64;

/// Allowed values for a readout's display `radix` (`wiring.pin`, `wiring.probe`,
/// `mem.register`). `dec` and `unsigned` name the same readout, and `bin` was
/// added for the UI's base chooser; the extra names stay accepted so older
/// files keep loading (UI_OVERHAUL §57).
const READOUT_RADIX: &[&str] = &["unsigned", "signed", "hex", "bin", "dec"];

/// Bits needed to name one of `n` input lines (⌈log₂ n⌉; at least 1).
/// Drives a priority decoder's `out` pin width.
pub fn index_bits(n: u32) -> u32 {
    addr_width(n)
}

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
    "plexers.priority-decoder",
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
    /// Input: consumes (sinks) the value of its net.
    In,
    /// Output: drives its net.
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
    /// AND.
    And,
    /// OR.
    Or,
    /// XOR (odd parity).
    Xor,
    /// AND with inverted output.
    Nand,
    /// OR with inverted output.
    Nor,
    /// XOR with inverted output.
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
    /// Logical left shift (`ll`).
    LogicalLeft,
    /// Logical right shift (`lr`).
    LogicalRight,
    /// Arithmetic (sign-preserving) right shift (`ar`).
    ArithRight,
    /// Rotate left (`rl`).
    RotateLeft,
    /// Rotate right (`rr`).
    RotateRight,
}

/// Bit-extender fill mode (`attrs.mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtendMode {
    /// Zero-fill the new upper bits (`zero`).
    Zero,
    /// Replicate the input's top bit (`sign`).
    Sign,
}

/// A component's typed configuration, parsed from `attrs` by `analyze`
/// (leniently: invalid values fall back to the same defaults the pin
/// signatures use, since netlisting runs only after validation passed).
#[derive(Debug, Clone, PartialEq)]
pub enum CompKind {
    /// NOT gate (`gate.not`).
    Not {
        /// Data width in bits.
        bitsize: u32,
    },
    /// Buffer (`gate.buffer`).
    Buffer {
        /// Data width in bits.
        bitsize: u32,
    },
    /// Multi-input gate (`gate.and`/`or`/`xor`/`nand`/`nor`/`xnor`).
    Gate {
        /// Gate function.
        op: GateOp,
        /// Data width in bits.
        bitsize: u32,
        /// Number of inputs (`inputs` attr, ≥ 2).
        inputs: u32,
    },
    /// Tri-state controlled buffer (`wiring.controlled-buffer`).
    ControlledBuffer {
        /// Data width in bits.
        bitsize: u32,
    },
    /// I/O pin (`wiring.pin`) — part of the containing circuit's interface.
    Pin {
        /// Width in bits.
        bitsize: u32,
        /// True when this pin is an output of its circuit (`isOutput` attr).
        is_output: bool,
    },
    /// Constant driver (`wiring.constant`).
    Constant {
        /// Width in bits.
        bitsize: u32,
        /// Driven value (`value` attr, parsed; invalid values were already
        /// reported by validation).
        value: Value,
    },
    /// Clock source (`wiring.clock`); single 1-bit output.
    Clock,
    /// Text annotation (`misc.text`); a label with no pins and no behavior.
    Text,
    /// Split pin name → bus bit indices (array position = split-pin bit),
    /// sorted by pin name; `bus_width` covers the highest mapped bit + 1.
    Splitter {
        /// Per split pin: (pin name, bus bit indices), sorted by pin name.
        splits: Vec<(String, Vec<u32>)>,
        /// Bus width in bits (highest mapped bit index + 1).
        bus_width: u32,
    },
    /// Probe (`wiring.probe`).
    Probe {
        /// Width in bits.
        bitsize: u32,
    },
    /// Multiplexer (`plexers.mux`).
    Mux {
        /// Data width in bits.
        bitsize: u32,
        /// Select width in bits (`selectBits` attr); 2^select data inputs.
        select_bits: u32,
    },
    /// Demultiplexer (`plexers.demux`).
    Demux {
        /// Data width in bits.
        bitsize: u32,
        /// Select width in bits (`selectBits` attr); 2^select data outputs.
        select_bits: u32,
    },
    /// Decoder (`plexers.decoder`).
    Decoder {
        /// Input width in bits (`inputBits` attr); 2^n one-hot outputs.
        input_bits: u32,
    },
    /// Priority decoder (`plexers.priority-decoder`). Named for the
    /// palette tile the course asked for; behaviorally it is the standard
    /// **priority encoder** — the highest-numbered asserted input line
    /// becomes its binary index on `out`, and `valid` marks "any input
    /// asserted".
    PriorityDecoder {
        /// Number of input lines (`inputBits` attr).
        input_bits: u32,
    },
    /// Adder (`arith.adder`); `a` + `b` + `cin` → `out`, `cout`.
    Adder {
        /// Data width in bits.
        bitsize: u32,
    },
    /// Subtractor (`arith.subtractor`); `a` − `b` − `bin` → `out`, `bout`.
    Subtractor {
        /// Data width in bits.
        bitsize: u32,
    },
    /// Multiplier (`arith.multiplier`); the output pin is double-width.
    Multiplier {
        /// Input width in bits (output is `2 × bitsize`).
        bitsize: u32,
    },
    /// Divider (`arith.divider`); quotient and remainder outputs.
    Divider {
        /// Data width in bits.
        bitsize: u32,
    },
    /// Comparator (`arith.comparator`); `lt`/`eq`/`gt` outputs.
    Comparator {
        /// Data width in bits.
        bitsize: u32,
    },
    /// Negator (two's complement, `arith.negator`).
    Negator {
        /// Data width in bits.
        bitsize: u32,
    },
    /// Shifter (`arith.shifter`).
    Shifter {
        /// Data width in bits.
        bitsize: u32,
        /// Shift mode (`shift` attr).
        mode: ShiftMode,
    },
    /// Bit extender (`arith.bit-extender`).
    BitExtender {
        /// Input width in bits (`inBits` attr).
        in_bits: u32,
        /// Output width in bits (`outBits` attr; must exceed `in_bits`).
        out_bits: u32,
        /// Fill mode for the new upper bits (`mode` attr).
        mode: ExtendMode,
    },
    /// Register (`mem.register`); `d`/`clk`/`en`/`rst` in, `q` out.
    Register {
        /// Width in bits.
        bitsize: u32,
    },
    /// RAM (`mem.ram`).
    Ram {
        /// Word width in bits.
        bitsize: u32,
        /// Depth in words (`depth` attr; power of two).
        depth: u32,
        /// Optional autoload file path (`autoload` attr; resolved by the loader).
        autoload: Option<String>,
        /// Optional inline `rle-hex-v1` image (`contents` attr).
        contents: Option<String>,
    },
    /// ROM (`mem.rom`).
    Rom {
        /// Word width in bits.
        bitsize: u32,
        /// Depth in words (`depth` attr; power of two).
        depth: u32,
        /// Optional autoload file path (`autoload` attr; resolved by the loader).
        autoload: Option<String>,
        /// Optional inline `rle-hex-v1` image (`contents` attr).
        contents: Option<String>,
    },
    /// Subcircuit instance (`subcircuit`); its pins come from the referenced
    /// circuit's `wiring.pin` components.
    Subcircuit {
        /// Name of the referenced circuit (`circuit` attr).
        circuit: String,
    },
    /// Button (`io.button`); single 1-bit output.
    Button,
    /// LED (`io.led`).
    Led {
        /// Width in bits.
        bitsize: u32,
    },
    /// Hex display (`io.hexdisplay`).
    HexDisplay {
        /// Input width in bits (default 4).
        bitsize: u32,
    },
}

/// Full typed configuration: the typed component kind plus its
/// attr-derived parameters. Timing is *not* per instance — it comes from
/// the delay table alone (DESIGN.md §4.3), so no component carries a delay
/// override.
#[derive(Debug, Clone, PartialEq)]
pub struct CompConfig {
    /// Typed component kind plus its attr-derived parameters.
    pub kind: CompKind,
}

/// A component pin's interface: name, direction, and width in bits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinSig {
    /// Pin name (e.g. `in0`, `out`, `bus`).
    pub name: String,
    /// Electrical direction (driver/sink accounting).
    pub dir: PinDir,
    /// Width in bits.
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

const GATE_ATTRS: &[&str] = &["bitsize"];

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
            c.finish();
            let kind = if type_ == "gate.not" {
                CompKind::Not { bitsize: b }
            } else {
                CompKind::Buffer { bitsize: b }
            };
            (vec![PinSig::i("in", b), PinSig::o("out", b)], c, kind)
        }
        "gate.and" | "gate.or" | "gate.xor" | "gate.nand" | "gate.nor" | "gate.xnor" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "inputs"]);
            let b = c.bitsize(1);
            let inputs = c.uint("inputs", 2, 2, MAX_GATE_INPUTS);
            c.finish();
            let mut pins: Vec<PinSig> = (0..inputs)
                .map(|i| PinSig::i(format!("in{i}"), b))
                .collect();
            pins.push(PinSig::o("out", b));
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
            };
            (pins, c, kind)
        }
        "wiring.controlled-buffer" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
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
            let mut c = AttrCheck::new(attrs, &["bitsize", "isOutput", "radix"]);
            let b = c.bitsize(1);
            let is_output = c.boolean("isOutput", false);
            c.enumeration("radix", READOUT_RADIX, "unsigned");
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
            let mut c = AttrCheck::new(attrs, &["bitsize", "value", "radix"]);
            let b = c.bitsize(1);
            let value = c.string("value", "0");
            // `radix` is DISPLAY-only — the stored `value` is always a hex string;
            // the editor uses it for the on-body readout (UI_OVERHAUL §53).
            let _ = c.enumeration("radix", &["hex", "bin", "dec"], "hex");
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
            let mut c = AttrCheck::new(attrs, &[]);
            c.finish();
            (vec![PinSig::o("out", 1)], c, CompKind::Clock)
        }
        // Splitter pins are bidirectional (InOut): which side drives is
        // resolved dynamically (DESIGN.md §6 "arbitrary bit mapping — the
        // bus plumbing").
        "wiring.splitter" => {
            let mut c = AttrCheck::new(attrs, &["splits"]);
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
            let mut c = AttrCheck::new(attrs, &["bitsize", "radix"]);
            let b = c.bitsize(1);
            c.enumeration("radix", READOUT_RADIX, "unsigned");
            c.finish();
            (vec![PinSig::i("in", b)], c, CompKind::Probe { bitsize: b })
        }
        "plexers.mux" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "selectBits"]);
            let b = c.bitsize(1);
            let sel = c.uint("selectBits", 1, 1, MAX_SELECT_BITS);
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
            let mut c = AttrCheck::new(attrs, &["bitsize", "selectBits"]);
            let b = c.bitsize(1);
            let sel = c.uint("selectBits", 1, 1, MAX_SELECT_BITS);
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
            let mut c = AttrCheck::new(attrs, &["inputBits"]);
            let bits = c.uint("inputBits", 2, 1, MAX_SELECT_BITS);
            c.finish();
            let mut pins = vec![PinSig::i("in", bits)];
            pins.extend((0..(1u32 << bits)).map(|i| PinSig::o(format!("out{i}"), 1)));
            (pins, c, CompKind::Decoder { input_bits: bits })
        }
        "plexers.priority-decoder" => {
            // N single-bit input lines (in0 = lowest priority) → the binary
            // index of the highest-numbered asserted line, plus `valid`.
            // Named `priority-decoder` per the course's palette wording
            // (UI_OVERHAUL §54) — behaviorally the standard priority encoder.
            let mut c = AttrCheck::new(attrs, &["inputBits"]);
            let lines = c.uint("inputBits", 4, 2, MAX_SELECT_BITS);
            c.finish();
            let mut pins: Vec<PinSig> =
                (0..lines).map(|i| PinSig::i(format!("in{i}"), 1)).collect();
            pins.push(PinSig::o("out", index_bits(lines)));
            pins.push(PinSig::o("valid", 1));
            (pins, c, CompKind::PriorityDecoder { input_bits: lines })
        }
        "arith.adder" => {
            let mut c = AttrCheck::new(attrs, GATE_ATTRS);
            let b = c.bitsize(1);
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
            c.finish();
            (
                vec![PinSig::i("in", b), PinSig::o("out", b)],
                c,
                CompKind::Negator { bitsize: b },
            )
        }
        "arith.shifter" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "shift"]);
            let b = c.bitsize(1);
            let shift = c.enumeration("shift", &["ll", "lr", "ar", "rl", "rr"], "ll");
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
            let mut c = AttrCheck::new(attrs, &["inBits", "outBits", "mode"]);
            let in_bits = c.uint("inBits", 8, 1, MAX_BITSIZE);
            let out_bits = c.uint("outBits", 16, 1, MAX_BITSIZE);
            let mode = c.enumeration("mode", &["zero", "sign"], "zero");
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
            // `radix` is display-only: how the stored value reads on the body
            // (and in the Inspector's base chooser, UI_OVERHAUL §57).
            let mut c = AttrCheck::new(attrs, &["bitsize", "radix"]);
            let b = c.bitsize(1);
            c.enumeration("radix", READOUT_RADIX, "unsigned");
            c.finish();
            (
                vec![
                    PinSig::i("d", b),
                    PinSig::i("clk", 1),
                    PinSig::i("en", 1),
                    PinSig::o("q", b),
                ],
                c,
                CompKind::Register { bitsize: b },
            )
        }
        "mem.ram" => {
            let mut c = AttrCheck::new(attrs, &["bitsize", "depth", "autoload", "contents"]);
            let b = c.bitsize(1);
            let depth = c.uint("depth", 256, 1, MAX_MEM_DEPTH);
            let autoload = c.opt_string("autoload");
            let contents = c.opt_string("contents");
            c.finish();
            if !depth.is_power_of_two() {
                c_issue(&mut c, format!("depth ({depth}) must be a power of two"));
            }
            if let Some(contents) = &contents {
                match crate::format::rle::parse(contents, depth as usize) {
                    Err(e) => c_issue(&mut c, format!("attr 'contents': {e}")),
                    Ok(words) => {
                        if b < 64 {
                            if let Some((i, w)) =
                                words.iter().enumerate().find(|(_, w)| **w >> b != 0)
                            {
                                c_issue(
                                    &mut c,
                                    format!(
                                        "attr 'contents': word {i} ({w:#x}) does not fit in {b} bits"
                                    ),
                                );
                            }
                        }
                    }
                }
            }
            (
                vec![
                    PinSig::i("addr", addr_width(depth)),
                    PinSig::i("din", b),
                    PinSig::o("dout", b),
                    PinSig::i("we", 1),
                    PinSig::i("clk", 1),
                    // Synchronous reset (UI decision): clears memory on a rising
                    // edge with rst=1; wins over a write (see behavior.rs).
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
            let mut c = AttrCheck::new(attrs, &["bitsize", "depth", "autoload", "contents"]);
            let b = c.bitsize(1);
            let depth = c.uint("depth", 256, 1, MAX_MEM_DEPTH);
            let autoload = c.opt_string("autoload");
            let contents = c.opt_string("contents");
            c.finish();
            if !depth.is_power_of_two() {
                c_issue(&mut c, format!("depth ({depth}) must be a power of two"));
            }
            if let Some(contents) = &contents {
                match crate::format::rle::parse(contents, depth as usize) {
                    Err(e) => c_issue(&mut c, format!("attr 'contents': {e}")),
                    Ok(words) => {
                        if b < 64 {
                            if let Some((i, w)) =
                                words.iter().enumerate().find(|(_, w)| **w >> b != 0)
                            {
                                c_issue(
                                    &mut c,
                                    format!(
                                        "attr 'contents': word {i} ({w:#x}) does not fit in {b} bits"
                                    ),
                                );
                            }
                        }
                    }
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
            let mut c = AttrCheck::new(attrs, &[]);
            c.finish();
            (vec![PinSig::o("out", 1)], c, CompKind::Button)
        }
        "io.led" => {
            // UI_OVERHAUL §49: the LED carries its own look — `color` (#rrggbb,
            // "" = theme accent) and `intensity` (0..100, the glow strength).
            let mut c = AttrCheck::new(attrs, &["bitsize", "color", "intensity"]);
            let b = c.bitsize(1);
            let color = c.string("color", "");
            if !color.is_empty() && !is_hex_color(&color) {
                c_issue(
                    &mut c,
                    format!("attr 'color' must be a #rrggbb string, got '{color}'"),
                );
            }
            let _ = c.uint("intensity", 80, 0, 100);
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
        // Text annotation (UI_OVERHAUL §37): a free-form label the editor draws
        // on the sheet. No pins, no behavior; `text` may be empty, `color` is
        // "" (theme default) or `#rrggbb`, `font` picks a family (§40).
        "misc.text" => {
            let mut c = AttrCheck::new(attrs, &["text", "color", "font"]);
            let _ = c.string("text", "");
            let color = c.string("color", "");
            if !color.is_empty() && !is_hex_color(&color) {
                c_issue(
                    &mut c,
                    format!("attr 'color' must be a #rrggbb string, got '{color}'"),
                );
            }
            let _ = c.enumeration("font", &["sans", "serif", "mono"], "sans");
            c.finish();
            (Vec::new(), c, CompKind::Text)
        }
        _ => return None,
    };
    Some((pins, c.issues, kind))
}

fn c_issue(c: &mut AttrCheck, message: String) {
    c.issues.push(message);
}

/// `#rrggbb` (exactly) — used for the text annotation's `color` attr.
fn is_hex_color(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
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
    analyze(type_, attrs).map(|(_, _, kind)| CompConfig { kind })
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
    fn text_annotation_has_no_pins_and_validates_text() {
        let (p, e) = pins(
            "misc.text",
            json!({ "text": "note", "color": "#ff0000", "font": "serif" }),
        );
        assert_eq!(p.unwrap(), Vec::<String>::new());
        assert!(e.is_empty());

        // A non-hex colour and an unknown font are load errors.
        let (_, e) = pins("misc.text", json!({ "color": "red" }));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("'color'"), "{:?}", e);
        let (_, e) = pins("misc.text", json!({ "font": "comic" }));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("'font'"), "{:?}", e);

        // A typo'd attr on an annotation is still a load error.
        let (_, e) = pins("misc.text", json!({ "txt": "typo" }));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("unknown attr 'txt'"), "{:?}", e);
    }

    #[test]
    fn gate_pin_names_and_negation() {
        let (p, e) = pins("gate.and", json!({"inputs": 3}));
        assert_eq!(p.unwrap(), vec!["in0", "in1", "in2", "out"]);
        assert!(e.is_empty());

        // `negateInputs` was removed (UI_OVERHAUL §24): it is now unknown.
        let (_, e) = pins("gate.and", json!({"inputs": 2, "negateInputs": ["in1"]}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("negateInputs"), "{:?}", e[0]);

        // Defaults: 2 inputs, 1 bit.
        let (p, e) = pins("gate.xor", json!({}));
        assert_eq!(p.unwrap(), vec!["in0", "in1", "out"]);
        assert!(e.is_empty());
    }

    /// `(name, width)` per pin.
    fn names_widths(type_: &str, attrs: Json) -> Vec<(String, u32)> {
        let mut errors = Vec::new();
        let attrs = attrs.as_object().unwrap().clone();
        let p = validate_component("main", 0, "c0", type_, &attrs, &mut errors);
        assert!(errors.is_empty(), "{errors:?}");
        p.unwrap().into_iter().map(|s| (s.name, s.width)).collect()
    }

    /// The editor must mirror these names AND widths (format-v2 §4): the editor
    /// used to disagree — `c_in`/`c_out` for the adder's carry, no subtractor
    /// borrow, a divider `out` instead of `quot`/`rem`, a 1-bit decoder `sel`
    /// instead of a bus `in`, and 1-bit `sel`/`amt` — and `format/validate.rs`
    /// then rejected every wire drawn on those pins. This is the engine half of
    /// the lock; the editor half is
    /// `frontend/src/editor/layout.test.ts` ("pin names track the engine
    /// registry" / "select / amount pins carry the engine's widths").
    #[test]
    fn pin_names_and_widths_match_the_editor_registry() {
        let expect = |v: &[(&str, u32)]| -> Vec<(String, u32)> {
            v.iter().map(|(n, w)| ((*n).to_string(), *w)).collect()
        };
        assert_eq!(
            names_widths("arith.adder", json!({ "bitsize": 8 })),
            expect(&[("a", 8), ("b", 8), ("cin", 1), ("out", 8), ("cout", 1),])
        );
        assert_eq!(
            names_widths("arith.subtractor", json!({ "bitsize": 8 })),
            expect(&[("a", 8), ("b", 8), ("bin", 1), ("out", 8), ("bout", 1),])
        );
        assert_eq!(
            names_widths("arith.divider", json!({ "bitsize": 8 })),
            expect(&[("a", 8), ("b", 8), ("quot", 8), ("rem", 8)])
        );
        // `amt` indexes `bitsize` values: addr_width(8) = 3.
        assert_eq!(
            names_widths("arith.shifter", json!({ "bitsize": 8 })),
            expect(&[("in", 8), ("amt", 3), ("out", 8)])
        );
        assert_eq!(
            names_widths("plexers.mux", json!({ "bitsize": 8, "selectBits": 2 })),
            expect(&[
                ("in0", 8),
                ("in1", 8),
                ("in2", 8),
                ("in3", 8),
                ("sel", 2),
                ("out", 8),
            ])
        );
        assert_eq!(
            names_widths("plexers.demux", json!({ "bitsize": 8, "selectBits": 2 })),
            expect(&[
                ("in", 8),
                ("sel", 2),
                ("out0", 8),
                ("out1", 8),
                ("out2", 8),
                ("out3", 8),
            ])
        );
        // The decoder's select IS its data input: a bus `in`, not a `sel`.
        assert_eq!(
            names_widths("plexers.decoder", json!({ "inputBits": 2 })),
            expect(&[
                ("in", 2),
                ("out0", 1),
                ("out1", 1),
                ("out2", 1),
                ("out3", 1),
            ])
        );
        // A MEMORY's `addr` width comes from its DEPTH, never the data width:
        // 256 words → 8 bits. The editor used to inherit `bitsize` here, which
        // made a fresh RAM draw a 1-bit address while the core indexed 256
        // words (so a correct 8-bit address was flagged as a mismatch).
        assert_eq!(
            names_widths("mem.ram", json!({ "bitsize": 8, "depth": 256 })),
            expect(&[("addr", 8), ("din", 8), ("dout", 8), ("we", 1), ("clk", 1),])
        );
        assert_eq!(
            names_widths("mem.rom", json!({ "bitsize": 8, "depth": 16 })),
            expect(&[("addr", 4), ("out", 8)])
        );
        // Address and data widths are independent.
        assert_eq!(
            names_widths("mem.ram", json!({ "bitsize": 32, "depth": 4 })),
            expect(&[
                ("addr", 2),
                ("din", 32),
                ("dout", 32),
                ("we", 1),
                ("clk", 1),
            ])
        );
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

        // Timing is unit-wide (from the delay table), never a per-instance
        // attr — `delay` is now an unknown attr.
        let (_, e) = pins("mem.register", json!({"delay": 5}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("unknown attr 'delay'"), "{:?}", e[0]);
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
        let (_, e) = pins("mem.ram", json!({"bitsize": 8, "contents": "3-0f 12"}));
        assert!(e.is_empty(), "{e:?}");
        // Words must fit the memory's bitsize (B11; an oversized word was
        // previously accepted and could panic engine construction).
        let (_, e) = pins("mem.ram", json!({"contents": "3-0f 12"}));
        assert_eq!(e.len(), 1, "{e:?}");
        assert!(e[0].message.contains("does not fit"), "{e:?}");
        let (_, e) = pins("mem.ram", json!({"contents": "3-0f-2"}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("contents"));
    }

    #[test]
    fn contents_longer_than_depth_is_a_load_error() {
        // F3: was previously validated against MAX_MEM_DEPTH and then
        // silently zeroed at engine build — now a clean load error.
        for t in ["mem.ram", "mem.rom"] {
            let (_, e) = pins(
                t,
                json!({"bitsize": 8, "depth": 2, "contents": "aa bb cc dd"}),
            );
            assert_eq!(e.len(), 1, "{t}");
            assert!(e[0].message.contains("exceeding"), "{:?}", e[0].message);
        }
        // Exactly-depth contents are fine.
        let (_, e) = pins(
            "mem.rom",
            json!({"bitsize": 8, "depth": 2, "contents": "aa bb"}),
        );
        assert!(e.is_empty(), "{e:?}");
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

    #[test]
    fn priority_decoder_pins() {
        let (p, e) = pins("plexers.priority-decoder", json!({"inputBits": 4}));
        assert!(e.is_empty());
        assert_eq!(p.unwrap(), vec!["in0", "in1", "in2", "in3", "out", "valid"]);
        // Index width = ceil(log2 n): 3 lines need 2 bits.
        let sigs = pin_sigs(
            "plexers.priority-decoder",
            json!({"inputBits": 3}).as_object().unwrap(),
        )
        .unwrap();
        assert_eq!(get(&sigs, "out").width, 2);
        assert_eq!(get(&sigs, "valid").width, 1);
        assert_eq!(get(&sigs, "in0").width, 1);
        // The 2-line floor rejects a 1-line request.
        let (_, e) = pins("plexers.priority-decoder", json!({"inputBits": 1}));
        assert!(!e.is_empty());
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
