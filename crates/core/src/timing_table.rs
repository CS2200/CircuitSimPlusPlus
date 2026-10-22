//! Delay tables (DESIGN.md §4.4, decision D13; BACKEND.md task B7).
//!
//! A delay table is **versioned data, not code**: published tables live as
//! JSON in `crates/core/data/` and are embedded into the binary, so a
//! `csim` build is self-contained and every run names exactly the numbers
//! it used. A `.csx` file's `settings.delayTable` names the table the
//! design is graded against; an unknown name is a clean load-time error
//! (format validation, never a guess).
//!
//! Lookup semantics (normative prose: `docs/delay-table.md`):
//!
//! - `prop` — combinational propagation delay; clk→Q for registers.
//! - `perBit` — ripple-carry scaling (adders): added once per bit beyond
//!   the first of the component's primary bitsize, i.e.
//!   `effective_prop = prop + perBit × (bitsize − 1)`.
//! - `setup` / `hold` — register and RAM write discipline (§4.3).
//! - `access` — RAM/ROM read settling time.
//! - `wire` — net transport delay = `wire_len × num / den` grid units.
//! - Timing is **unit-wide**: the table is the only source of delays; there
//!   is no per-instance override.
//!
//! A table must define every kind in `REQUIRED_KINDS`; zero-timing
//! kinds (wiring/io) may be listed explicitly for documentation. Unknown
//! component keys are errors — a misspelled entry must not silently zero
//! a delay.

use std::collections::BTreeMap;

use serde::Deserialize;
use thiserror::Error;

use crate::behavior::Timing;
use crate::components::KNOWN_TYPES;

/// The embedded reference table (DRAFT 74LS typicals, DESIGN.md §4.4).
/// The built-in table. **Wire propagation is disabled** (`"wire": { "num": 0 }`) for the
/// first production run, by Head-TA decision: a conversion has to reproduce CircuitSim
/// CE, which has no delay at all, and per-path wire delays brought *clock skew* with them
/// — an edge reaching registers at different times, which CE's atomic edge never does (a
/// converted CPU lost its first instruction to exactly that). Only component delays
/// count for now; the per-path machinery is still built and simply contributes 0, so
/// turning `num` back on restores it.
const BUILTIN_74LS_V1: &str = include_str!("../data/cs2200-74ls-v1.json");

/// Component kinds a table must define — everything with a nonzero delay
/// in the reference table. Kinds not listed here are ideal (no delay).
const REQUIRED_KINDS: &[&str] = &[
    "arith.adder",
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
    "mem.ram",
    "mem.register",
    "mem.rom",
    "plexers.decoder",
    "plexers.demux",
    "plexers.mux",
    "plexers.priority-decoder",
    "wiring.controlled-buffer",
];

/// The only kinds whose delay scales with bitsize (DESIGN.md §4.4:
/// "adder scales per-bit (ripple)").
const PER_BIT_KINDS: &[&str] = &["arith.adder", "arith.subtractor"];

/// Why a table name or table body was rejected.
#[derive(Debug, Error)]
pub enum TableError {
    /// The named table does not exist.
    #[error("unknown delay table '{name}' (available: {})", available.join(", "))]
    Unknown {
        /// The requested table name.
        name: String,
        /// The table names that do exist.
        available: Vec<&'static str>,
    },
    /// The table file is not valid JSON.
    #[error("delay table: JSON parse error: {0}")]
    Json(String),
    /// The table parsed but failed semantic validation.
    #[error("delay table '{name}' is invalid:\n- {}", issues.join("\n- "))]
    Invalid {
        /// Name of the offending table.
        name: String,
        /// The validation failures, one per string.
        issues: Vec<String>,
    },
}

/// One component kind's timing parameters (absent fields default to 0).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Entry {
    prop: u64,
    per_bit: u64,
    setup: u64,
    hold: u64,
    access: u64,
}

/// A loaded, validated delay table. Lookups are total: kinds absent from
/// the table (and not required to be present) have zero timing.
#[derive(Debug, Clone)]
pub struct TimingTable {
    name: String,
    status: String,
    wire_num: u64,
    wire_den: u64,
    entries: BTreeMap<String, Entry>,
}

// -- Serde view of the file format --------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTable {
    name: String,
    /// Informational provenance marker ("DRAFT" until staff finalize).
    #[serde(default)]
    status: String,
    units: String,
    wire: RawWire,
    #[serde(default)]
    components: BTreeMap<String, RawEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWire {
    num: u64,
    den: u64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
struct RawEntry {
    prop: u64,
    #[serde(rename = "perBit")]
    per_bit: u64,
    setup: u64,
    hold: u64,
    access: u64,
}

impl TimingTable {
    /// Resolve a published table by name (`settings.delayTable`).
    pub fn builtin(name: &str) -> Result<TimingTable, TableError> {
        match name {
            "cs2200-74ls-v1" => TimingTable::from_json(BUILTIN_74LS_V1),
            _ => Err(TableError::Unknown {
                name: name.to_string(),
                available: Self::builtin_names().to_vec(),
            }),
        }
    }

    /// The table names this build ships.
    pub fn builtin_names() -> &'static [&'static str] {
        &["cs2200-74ls-v1"]
    }

    /// Parse and validate a table from JSON (tests; future custom tables).
    pub fn from_json(json: &str) -> Result<TimingTable, TableError> {
        let raw: RawTable =
            serde_json::from_str(json).map_err(|e| TableError::Json(e.to_string()))?;
        let mut issues = Vec::new();
        if raw.name.is_empty() {
            issues.push("'name' must not be empty".to_string());
        }
        if raw.units != "ns" {
            issues.push(format!("'units' must be \"ns\", got '{}'", raw.units));
        }
        if raw.wire.den == 0 {
            issues.push("'wire.den' must be nonzero".to_string());
        }
        for key in raw.components.keys() {
            if !KNOWN_TYPES.contains(&key.as_str()) {
                issues.push(format!("components.'{key}': unknown component type"));
            }
        }
        for &kind in REQUIRED_KINDS {
            if !raw.components.contains_key(kind) {
                issues.push(format!("components.'{kind}': required entry missing"));
            }
        }
        for (key, entry) in &raw.components {
            if entry.per_bit != 0 && !PER_BIT_KINDS.contains(&key.as_str()) {
                issues.push(format!(
                    "components.'{key}': 'perBit' is only meaningful for {PER_BIT_KINDS:?}"
                ));
            }
        }
        if !issues.is_empty() {
            return Err(TableError::Invalid {
                name: raw.name,
                issues,
            });
        }
        let entries = raw
            .components
            .into_iter()
            .map(|(k, e)| {
                (
                    k,
                    Entry {
                        prop: e.prop,
                        per_bit: e.per_bit,
                        setup: e.setup,
                        hold: e.hold,
                        access: e.access,
                    },
                )
            })
            .collect();
        Ok(TimingTable {
            name: raw.name,
            status: raw.status,
            wire_num: raw.wire.num,
            wire_den: raw.wire.den,
            entries,
        })
    }

    /// The table's own name (`cs2200-74ls-v1`).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Provenance marker: `"DRAFT"` until staff finalize the values (D13).
    pub fn status(&self) -> &str {
        &self.status
    }

    /// Transport delay of a net from its accumulated wire length (grid
    /// units). `num = 0` disables wire delay (§4.4).
    pub fn wire_delay(&self, wire_len: u32) -> u64 {
        u64::from(wire_len) * self.wire_num / self.wire_den
    }

    /// Timing for one component instance: the table entry with per-bit
    /// scaling applied. Timing is unit-wide — there is no per-instance
    /// override (§4.3).
    pub fn timing(&self, type_: &str, bitsize: u32) -> Timing {
        let e = self.entries.get(type_).copied().unwrap_or_default();
        let effective = e.prop + e.per_bit * u64::from(bitsize.saturating_sub(1));
        Timing {
            prop: effective,
            setup: e.setup,
            hold: e.hold,
            access: e.access,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> TimingTable {
        TimingTable::builtin("cs2200-74ls-v1").expect("embedded table is valid")
    }

    #[test]
    fn builtin_loads_with_reference_values() {
        let t = table();
        assert_eq!(t.name(), "cs2200-74ls-v1");
        assert_eq!(t.status(), "DRAFT");
        // DRAFT 74LS anchors (DESIGN.md §4.4).
        assert_eq!(t.timing("gate.not", 1).prop, 9);
        assert_eq!(t.timing("gate.and", 8).prop, 10);
        assert_eq!(t.timing("gate.xor", 1).prop, 12);
        assert_eq!(t.timing("plexers.mux", 1).prop, 12);
        let reg = t.timing("mem.register", 32);
        assert_eq!((reg.prop, reg.setup, reg.hold), (20, 15, 5));
        let ram = t.timing("mem.ram", 32);
        assert_eq!((ram.access, ram.setup, ram.hold), (50, 15, 5));
        assert_eq!(t.timing("mem.rom", 32).access, 50);
        // Wire propagation ships **disabled** (`wire.num = 0`): only component delays
        // count for now (Head-TA decision for the first production run — see
        // `BUILTIN_74LS_V1`). The constant is still data: a table that sets it gets it
        // back, which `delay.rs`'s wire tests do to keep the per-path machinery covered.
        assert_eq!(t.wire_delay(200), 0);
        assert_eq!(t.wire_delay(9), 0);
        let mut wired: serde_json::Value = serde_json::from_str(BUILTIN_74LS_V1).unwrap();
        wired["wire"]["num"] = serde_json::json!(1);
        let t = TimingTable::from_json(&wired.to_string()).unwrap();
        assert_eq!(t.wire_delay(200), 20);
        assert_eq!(t.wire_delay(9), 0);
    }

    #[test]
    fn zero_timing_kinds_are_ideal() {
        let t = table();
        for kind in [
            "wiring.pin",
            "wiring.constant",
            "wiring.clock",
            "wiring.probe",
            "wiring.splitter",
            "arith.bit-extender",
            "io.led",
            "debug.breakpoint",
        ] {
            assert_eq!(t.timing(kind, 1), Timing::default(), "{kind}");
        }
    }

    #[test]
    fn adder_scales_per_bit_ripple() {
        let t = table();
        assert_eq!(t.timing("arith.adder", 1).prop, 15);
        assert_eq!(t.timing("arith.adder", 2).prop, 19);
        assert_eq!(t.timing("arith.adder", 32).prop, 15 + 31 * 4);
        // Non-scaling kinds ignore bitsize.
        assert_eq!(t.timing("arith.multiplier", 32).prop, 15);
    }

    #[test]
    fn unknown_table_name_is_a_clean_error() {
        let e = TimingTable::builtin("cs2200-74ls-v99").unwrap_err();
        let msg = e.to_string();
        assert!(msg.contains("cs2200-74ls-v99"), "{msg}");
        assert!(msg.contains("cs2200-74ls-v1"), "{msg}");
    }

    #[test]
    fn malformed_tables_collect_all_issues() {
        // Unknown component key + missing required entries + bad den.
        let bad = r#"{
            "name": "t", "units": "ns", "wire": { "num": 1, "den": 0 },
            "components": { "gate.andd": { "prop": 10 } }
        }"#;
        let TableError::Invalid { issues, .. } = TimingTable::from_json(bad).unwrap_err() else {
            panic!("expected Invalid");
        };
        assert!(issues.iter().any(|i| i.contains("wire.den")), "{issues:?}");
        assert!(issues.iter().any(|i| i.contains("gate.andd")), "{issues:?}");
        assert!(issues.iter().any(|i| i.contains("gate.not")), "{issues:?}");
        assert!(issues.iter().any(|i| i.contains("mem.rom")), "{issues:?}");
    }

    #[test]
    fn table_validation_rejects_bad_units_unknown_fields_and_perbit_abuse() {
        let bad_units = r#"{
            "name": "t", "units": "ps", "wire": { "num": 1, "den": 10 }
        }"#;
        assert!(matches!(
            TimingTable::from_json(bad_units),
            Err(TableError::Invalid { .. })
        ));
        let unknown_field = r#"{
            "name": "t", "units": "ns", "wire": { "num": 1, "den": 10, "x": 1 }
        }"#;
        assert!(matches!(
            TimingTable::from_json(unknown_field),
            Err(TableError::Json(_))
        ));
        let mut perbit_abuse: serde_json::Value = serde_json::from_str(BUILTIN_74LS_V1).unwrap();
        perbit_abuse["components"]["gate.not"]["perBit"] = serde_json::json!(1);
        let TableError::Invalid { issues, .. } =
            TimingTable::from_json(&perbit_abuse.to_string()).unwrap_err()
        else {
            panic!("expected Invalid");
        };
        assert!(issues.iter().any(|i| i.contains("perBit")), "{issues:?}");
    }

    #[test]
    fn not_json_is_a_parse_error() {
        assert!(matches!(
            TimingTable::from_json("{nope"),
            Err(TableError::Json(_))
        ));
    }

    #[test]
    fn zero_wire_numerator_disables_wire_delay() {
        let mut v: serde_json::Value = serde_json::from_str(BUILTIN_74LS_V1).unwrap();
        v["wire"]["num"] = serde_json::json!(0);
        let t = TimingTable::from_json(&v.to_string()).unwrap();
        assert_eq!(t.wire_delay(10_000), 0);
    }
}
