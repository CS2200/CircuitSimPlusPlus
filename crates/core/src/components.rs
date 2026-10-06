//! Component registry: known type strings, pin names, and attribute
//! validation (README §4 naming; DESIGN.md §6; `docs/format-v2.md`).
//!
//! This table is the single source of truth for component *interfaces* —
//! the set of pin names a component instance exposes, as a function of its
//! `attrs`. B2 (load validation) uses it to resolve wire endpoints; B3
//! (netlist builder) and B4 (behaviors) build on the same table.
//!
//! Only interfaces live here — no simulation behavior.

use std::collections::BTreeSet;

use serde_json::{Map, Value as Json};

use crate::api::{CompId, LoadError, LoadErrorKind};
use crate::value::Value;

/// Hard sanity caps (DESIGN.md §11 — corrupt files must not be able to
/// OOM the grader). Generous enough that no real course circuit hits them.
pub const MAX_BITSIZE: u32 = 1024;
pub const MAX_GATE_INPUTS: u32 = 64;
pub const MAX_SELECT_BITS: u32 = 8;
pub const MAX_MEM_DEPTH: u32 = 1 << 24;
pub const MAX_SPLIT_PINS: u32 = 64;

/// Helper that accumulates attribute errors for one component.
struct AttrCheck<'a> {
    attrs: &'a Map<String, Json>,
    allowed: &'a [&'a str],
    circuit: &'a str,
    comp_idx: usize,
    comp_id: &'a str,
    errors: &'a mut Vec<LoadError>,
}

impl<'a> AttrCheck<'a> {
    fn new(
        attrs: &'a Map<String, Json>,
        allowed: &'a [&'a str],
        circuit: &'a str,
        comp_idx: usize,
        comp_id: &'a str,
        errors: &'a mut Vec<LoadError>,
    ) -> Self {
        AttrCheck {
            attrs,
            allowed,
            circuit,
            comp_idx,
            comp_id,
            errors,
        }
    }

    fn err(&mut self, message: String) {
        self.errors.push(LoadError {
            kind: LoadErrorKind::Other,
            message,
            circuit: self.circuit.to_string(),
            comp_id: Some(CompId(self.comp_idx as u32)),
            wire_idx: None,
        });
    }

    /// Integer attribute with default and inclusive range.
    fn uint(&mut self, name: &str, default: u32, min: u32, max: u32) -> u32 {
        match self.attrs.get(name) {
            None => default,
            Some(Json::Number(n)) => match n.as_u64().and_then(|v| u32::try_from(v).ok()) {
                Some(v) if (min..=max).contains(&v) => v,
                Some(v) => {
                    self.err(format!(
                        "component '{}': attr '{name}' = {v} out of range {min}..={max}",
                        self.comp_id
                    ));
                    default
                }
                None => {
                    self.err(format!(
                        "component '{}': attr '{name}' must be an unsigned integer",
                        self.comp_id
                    ));
                    default
                }
            },
            Some(other) => {
                self.err(format!(
                    "component '{}': attr '{name}' must be an unsigned integer, got {other}",
                    self.comp_id
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
                self.err(format!(
                    "component '{}': attr '{name}' must be a boolean, got {other}",
                    self.comp_id
                ));
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
                self.err(format!(
                    "component '{}': attr '{name}' must be a string or null, got {other}",
                    self.comp_id
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
                self.err(format!(
                    "component '{}': attr '{name}' must be a string, got {other}",
                    self.comp_id
                ));
                default.to_string()
            }
        }
    }

    fn enumeration(&mut self, name: &str, choices: &[&str], default: &str) -> String {
        let v = self.string(name, default);
        if !choices.contains(&v.as_str()) {
            self.err(format!(
                "component '{}': attr '{name}' must be one of {choices:?}, got '{v}'",
                self.comp_id
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
                        None => self.err(format!(
                            "component '{}': attr '{name}' entries must be strings, got {it}",
                            self.comp_id
                        )),
                    }
                }
                out
            }
            Some(other) => {
                self.err(format!(
                    "component '{}': attr '{name}' must be an array of strings, got {other}",
                    self.comp_id
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
            Some(other) => self.err(format!(
                "component '{}': attr 'delay' must be null or a non-negative integer, got {other}",
                self.comp_id
            )),
        }
    }

    /// Every attribute key must be known — a typo'd attr name is an error,
    /// not silently ignored.
    fn finish(self) {
        for key in self.attrs.keys() {
            if !self.allowed.contains(&key.as_str()) {
                self.errors.push(LoadError {
                    kind: LoadErrorKind::Other,
                    message: format!(
                        "component '{}': unknown attr '{key}' for this component type",
                        self.comp_id
                    ),
                    circuit: self.circuit.to_string(),
                    comp_id: Some(CompId(self.comp_idx as u32)),
                    wire_idx: None,
                });
            }
        }
    }
}

const GATE_PINS_COMMON: &[&str] = &["bitsize", "delay"];

/// Validate a component's attrs and return its pin names. Returns `None`
/// for an unknown type string (error recorded); pin-name checks on wires
/// connected to such a component are skipped by the caller.
///
/// On invalid attrs the errors are recorded and pin names are derived with
/// defaults substituted, so wire-endpoint resolution still works.
pub fn validate_component(
    circuit: &str,
    comp_idx: usize,
    comp_id: &str,
    type_: &str,
    attrs: &Map<String, Json>,
    errors: &mut Vec<LoadError>,
) -> Option<Vec<String>> {
    match type_ {
        "gate.not" | "gate.buffer" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(1);
            c.delay();
            c.finish();
            Some(vec!["in".into(), "out".into()])
        }
        "gate.and" | "gate.or" | "gate.xor" | "gate.nand" | "gate.nor" | "gate.xnor" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "inputs", "negateInputs", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            c.bitsize(1);
            let inputs = c.uint("inputs", 2, 2, MAX_GATE_INPUTS);
            let negate = c.string_list("negateInputs");
            c.delay();
            c.finish();
            let mut pins: Vec<String> = (0..inputs).map(|i| format!("in{i}")).collect();
            pins.push("out".into());
            let pin_set: BTreeSet<&String> = pins.iter().collect();
            for name in negate {
                if !pin_set.contains(&name) || name == "out" {
                    c_err(
                        errors,
                        circuit,
                        comp_idx,
                        format!(
                            "component '{comp_id}': negateInputs entry '{name}' is not one of its input pins"
                        ),
                    );
                }
            }
            Some(pins)
        }
        "wiring.controlled-buffer" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(1);
            c.delay();
            c.finish();
            Some(vec!["in".into(), "en".into(), "out".into()])
        }
        "wiring.pin" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "isOutput", "radix", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            c.bitsize(1);
            c.boolean("isOutput", false);
            c.enumeration("radix", &["unsigned", "signed", "hex"], "unsigned");
            c.finish();
            Some(vec!["pin".into()])
        }
        "wiring.constant" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "value", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            let bitsize = c.bitsize(1);
            let value = c.string("value", "0");
            c.delay();
            c.finish();
            if let Err(e) = Value::from_hex_masks(bitsize, &value, "", "") {
                c_err(
                    errors,
                    circuit,
                    comp_idx,
                    format!("component '{comp_id}': attr 'value': {e}"),
                );
            }
            Some(vec!["out".into()])
        }
        "wiring.clock" => {
            AttrCheck::new(attrs, &["delay"], circuit, comp_idx, comp_id, errors).finish();
            Some(vec!["out".into()])
        }
        "wiring.splitter" => {
            let mut c = AttrCheck::new(
                attrs,
                &["splits", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            c.delay();
            let splits = match attrs.get("splits") {
                None => {
                    c.err(format!(
                        "component '{comp_id}': splitter requires attr 'splits'"
                    ));
                    Map::new()
                }
                Some(Json::Object(m)) => m.clone(),
                Some(other) => {
                    c.err(format!(
                        "component '{comp_id}': attr 'splits' must be an object mapping pin names to bit-index arrays, got {other}"
                    ));
                    Map::new()
                }
            };
            c.finish();
            // Every bus bit covered exactly once; pin count bounded.
            let mut pins = vec!["bus".to_string()];
            let mut seen: Vec<u32> = Vec::new();
            for (name, bits) in &splits {
                pins.push(name.clone());
                match bits {
                    Json::Array(items) if !items.is_empty() => {
                        for it in items {
                            match it.as_u64().and_then(|v| u32::try_from(v).ok()) {
                                Some(b) if b < MAX_BITSIZE => seen.push(b),
                                _ => c_err(
                                    errors,
                                    circuit,
                                    comp_idx,
                                    format!(
                                        "component '{comp_id}': splits entry '{name}' has invalid bit index {it}"
                                    ),
                                ),
                            }
                        }
                    }
                    _ => c_err(
                        errors,
                        circuit,
                        comp_idx,
                        format!(
                            "component '{comp_id}': splits entry '{name}' must be a non-empty array of bit indices"
                        ),
                    ),
                }
            }
            if splits.len() as u32 > MAX_SPLIT_PINS {
                c_err(
                    errors,
                    circuit,
                    comp_idx,
                    format!("component '{comp_id}': too many split pins (max {MAX_SPLIT_PINS})"),
                );
            }
            let mut sorted = seen.clone();
            sorted.sort_unstable();
            for (i, &b) in sorted.iter().enumerate() {
                if b != i as u32 {
                    c_err(
                        errors,
                        circuit,
                        comp_idx,
                        format!(
                            "component '{comp_id}': splits must cover every bus bit exactly once (bit {i} missing or duplicated)"
                        ),
                    );
                    break;
                }
            }
            Some(pins)
        }
        "wiring.probe" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "radix", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            c.bitsize(1);
            c.enumeration("radix", &["unsigned", "signed", "hex"], "unsigned");
            c.finish();
            Some(vec!["in".into()])
        }
        "plexers.mux" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "selectBits", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            c.bitsize(1);
            let sel = c.uint("selectBits", 1, 1, MAX_SELECT_BITS);
            c.delay();
            c.finish();
            let mut pins: Vec<String> = (0..(1u32 << sel)).map(|i| format!("in{i}")).collect();
            pins.push("sel".into());
            pins.push("out".into());
            Some(pins)
        }
        "plexers.demux" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "selectBits", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            c.bitsize(1);
            let sel = c.uint("selectBits", 1, 1, MAX_SELECT_BITS);
            c.delay();
            c.finish();
            let mut pins = vec!["in".to_string(), "sel".to_string()];
            pins.extend((0..(1u32 << sel)).map(|i| format!("out{i}")));
            Some(pins)
        }
        "plexers.decoder" => {
            let mut c = AttrCheck::new(
                attrs,
                &["inputBits", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            let bits = c.uint("inputBits", 2, 1, MAX_SELECT_BITS);
            c.delay();
            c.finish();
            let mut pins = vec!["in".to_string()];
            pins.extend((0..(1u32 << bits)).map(|i| format!("out{i}")));
            Some(pins)
        }
        "arith.adder" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(1);
            c.delay();
            c.finish();
            Some(vec![
                "a".into(),
                "b".into(),
                "cin".into(),
                "out".into(),
                "cout".into(),
            ])
        }
        "arith.subtractor" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(1);
            c.delay();
            c.finish();
            Some(vec![
                "a".into(),
                "b".into(),
                "bin".into(),
                "out".into(),
                "bout".into(),
            ])
        }
        "arith.multiplier" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(1);
            c.delay();
            c.finish();
            Some(vec!["a".into(), "b".into(), "out".into()])
        }
        "arith.divider" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(1);
            c.delay();
            c.finish();
            Some(vec!["a".into(), "b".into(), "quot".into(), "rem".into()])
        }
        "arith.comparator" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(1);
            c.delay();
            c.finish();
            Some(vec![
                "a".into(),
                "b".into(),
                "lt".into(),
                "eq".into(),
                "gt".into(),
            ])
        }
        "arith.negator" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(1);
            c.delay();
            c.finish();
            Some(vec!["in".into(), "out".into()])
        }
        "arith.shifter" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "shift", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            c.bitsize(1);
            c.enumeration("shift", &["ll", "lr", "ar", "rl", "rr"], "ll");
            c.delay();
            c.finish();
            Some(vec!["in".into(), "amt".into(), "out".into()])
        }
        "arith.bit-extender" => {
            let mut c = AttrCheck::new(
                attrs,
                &["inBits", "outBits", "mode", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            let in_bits = c.uint("inBits", 8, 1, MAX_BITSIZE);
            let out_bits = c.uint("outBits", 16, 1, MAX_BITSIZE);
            c.enumeration("mode", &["zero", "sign"], "zero");
            c.delay();
            c.finish();
            if out_bits <= in_bits {
                c_err(
                    errors,
                    circuit,
                    comp_idx,
                    format!(
                        "component '{comp_id}': bit-extender requires outBits ({out_bits}) > inBits ({in_bits})"
                    ),
                );
            }
            Some(vec!["in".into(), "out".into()])
        }
        "mem.register" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(1);
            c.delay();
            c.finish();
            Some(vec![
                "d".into(),
                "clk".into(),
                "en".into(),
                "rst".into(),
                "q".into(),
            ])
        }
        "mem.ram" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "depth", "autoload", "contents", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            c.bitsize(1);
            c.uint("depth", 256, 1, MAX_MEM_DEPTH);
            c.opt_string("autoload");
            let contents = c.opt_string("contents");
            c.delay();
            c.finish();
            if let Some(contents) = contents {
                if let Err(e) = crate::format::rle::parse(&contents, MAX_MEM_DEPTH as usize) {
                    c_err(
                        errors,
                        circuit,
                        comp_idx,
                        format!("component '{comp_id}': attr 'contents': {e}"),
                    );
                }
            }
            Some(vec![
                "addr".into(),
                "din".into(),
                "dout".into(),
                "we".into(),
                "clk".into(),
            ])
        }
        "mem.rom" => {
            let mut c = AttrCheck::new(
                attrs,
                &["bitsize", "depth", "autoload", "contents", "delay"],
                circuit,
                comp_idx,
                comp_id,
                errors,
            );
            c.bitsize(1);
            c.uint("depth", 256, 1, MAX_MEM_DEPTH);
            c.opt_string("autoload");
            let contents = c.opt_string("contents");
            c.delay();
            c.finish();
            if let Some(contents) = contents {
                if let Err(e) = crate::format::rle::parse(&contents, MAX_MEM_DEPTH as usize) {
                    c_err(
                        errors,
                        circuit,
                        comp_idx,
                        format!("component '{comp_id}': attr 'contents': {e}"),
                    );
                }
            }
            Some(vec!["addr".into(), "out".into()])
        }
        "subcircuit" => {
            let mut c = AttrCheck::new(attrs, &["circuit"], circuit, comp_idx, comp_id, errors);
            match attrs.get("circuit") {
                Some(Json::String(_)) => {}
                other => c.err(format!(
                    "component '{comp_id}': subcircuit requires a string attr 'circuit', got {}",
                    other.map_or("nothing".to_string(), |o| o.to_string())
                )),
            }
            c.finish();
            // Pins come from the referenced circuit's pin components; the
            // validator resolves them (it owns document context).
            Some(Vec::new())
        }
        "io.button" => {
            AttrCheck::new(attrs, &["delay"], circuit, comp_idx, comp_id, errors).finish();
            Some(vec!["out".into()])
        }
        "io.led" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(1);
            c.finish();
            Some(vec!["in".into()])
        }
        "io.hexdisplay" => {
            let mut c = AttrCheck::new(attrs, GATE_PINS_COMMON, circuit, comp_idx, comp_id, errors);
            c.bitsize(4);
            c.finish();
            Some(vec!["in".into()])
        }
        _ => {
            c_err(
                errors,
                circuit,
                comp_idx,
                format!("component '{comp_id}': unknown component type '{type_}'"),
            );
            None
        }
    }
}

fn c_err(errors: &mut Vec<LoadError>, circuit: &str, comp_idx: usize, message: String) {
    errors.push(LoadError {
        kind: LoadErrorKind::Other,
        message,
        circuit: circuit.to_string(),
        comp_id: Some(CompId(comp_idx as u32)),
        wire_idx: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pins(type_: &str, attrs: Json) -> (Option<Vec<String>>, Vec<LoadError>) {
        let mut errors = Vec::new();
        let attrs = attrs.as_object().unwrap().clone();
        let p = validate_component("main", 0, "c0", type_, &attrs, &mut errors);
        (p, errors)
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
    fn memory_contents_checked() {
        let (_, e) = pins("mem.ram", json!({"contents": "3-0f 12"}));
        assert!(e.is_empty());
        let (_, e) = pins("mem.ram", json!({"contents": "3-0f-2"}));
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("contents"));
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
