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
/// turning `num` back on restores it.///
/// **And that has a second consequence, which matters: it removes *clock skew*.** A clock
/// edge is delivered per sink like any other transition, so with wire delays a register
/// further from the clock source clocks later than one nearer — and a design built for CE,
/// whose edge is atomic (one oscillator toggling every clocked part at once), can latch a
/// value a cycle early. That is not hypothetical: it cost a converted CPU its first
/// instruction, because the PC (clocked early) advanced and only then did the IF/ID latch
/// (clocked late) sample the *new* fetch. Real silicon **does** have skew — accounting for
/// it is a legitimate thing to want — so this is a simplification, not a correction, and it
/// is the reason the two must move together: whenever wire propagation comes back, the
/// "one global clock domain" rule (DESIGN.md §4.3) has to come back with it, or that bug
/// returns with it.
const BUILTIN_74LS_V1: &str = include_str!("../data/cs2200-74ls-v1.json");

/// The recalibrated table (`cs2200-74ls-v2`). Same 74LS board-level regime as v1, with two
/// corrections that decide whether pipelining pays:
///
/// - **Memory was ~40% too fast.** v1 charged SRAM/ROM 50 ns; the real parts are a
///   62256-70 (`tAA` 70 ns) and a 27C256-120 (`tACC` 120 ns). This is the term that
///   makes the memory-dominated MIPS regime reproducible — see `docs/delay-table.md`.
/// - **The adder was charged as a ripple chain — kept.** v1's `prop 15 + perBit 4` is
///   139 ns for 32 bits; a real 74LS181 slice is 22 ns typ and inter-slice carry is
///   ~25 ns, so a 32-bit ripple add is **208 ns**. v1 therefore paired its worst-case
///   ALU with its best-case memory (50 ns), maximizing the ALU's share of the critical
///   path — the opposite of the R2000, whose clock was set by its external SRAM
///   (`R2000/12` 12.5 MHz @ 35 ns). v2 charges both honestly: memory 70/120 ns, ripple
///   adder 208 ns. The adder is the term a *single-cycle* machine serializes twice
///   (PC+4 and the ALU op) and a pipeline only once per stage, which is what makes
///   pipelining pay (see `docs/delay-table.md` for the measurement). A lookahead
///   variant (`74LS182`, 53 ns @ 32) flips that — kept as a documented staff option.
///
/// Every entry carries a `source` naming the part and parameter it came from, so the
/// numbers are auditable rather than asserted.
const BUILTIN_74LS_V2: &str = include_str!("../data/cs2200-74ls-v2.json");

/// The current table (`mips-r2000-2um-v1`): the MIPS R2000's own technology, 2.0 µm
/// CMOS, replacing the 74LS board-level idea entirely.
///
/// The 74LS tables modelled a machine whose critical path was one atomic 74LS181 ripple
/// adder (208 ns) against a 70 ns SRAM — an ALU-bound machine, where pipelining converts a
/// sum into a max and gains almost nothing (~1.5×). That is a true property of a TTL
/// board, but it is not the machine this course is about, and it silently decided the
/// whole assignment: a one-cycle datapath came within 5% of a 5-stage pipeline.
///
/// At 2.0 µm CMOS the ratio inverts. Anchors, all from the R2000's datasheet and CPU-DB
/// entry: **FO4 = 720 ps**, clocks 12.5 MHz (80 ns) / 16.7 MHz (60 ns), external cache
/// **SRAM 35 ns / 25 ns**, 5-stage integer pipeline, ~110k transistors, 2 metal layers.
/// Logic collapses by roughly 10× (a 74LS gate is 9-10 ns because it drives a board's
/// 15 pF with milliamps; a 2 µm gate is ~2 ns driving femtofarads). Memory does *not*
/// collapse — a 32Kx8 SRAM is a board part with a board part's access time.
///
/// So memory dominates every stage, the single-cycle path contains **two** memory accesses
/// where a pipeline stage contains one, and `Σ/max` becomes ~2.5-3× — a margin a clock
/// threshold can separate. `mem.ram`/`mem.rom` are priced per address bit for the same
/// reason as in v2: a 32-word register file and a 32K-word program store are not the same
/// part.
const BUILTIN_R2000_2UM: &str = include_str!("../data/mips-r2000-2um-v1.json");

/// **`ce-zero-delay-v1` — a diagnostic, not a technology.** CircuitSim CE has no delay at
/// all: a net's value is whatever its drivers say the instant they say it, and a
/// combinational cycle settles to a fixed point within the tick. This table is that model
/// — every `prop`/`access`/`setup`/`hold` zero — so `compat` can be run the way CE
/// actually evaluates, which is what designs containing a control-word/microcode-state
/// loop need (docs/bugs.md, "`compat` and the last four corpus rows"). It is never the
/// default: `t_obs` under it is 0 by construction, and grading needs real delays.
const BUILTIN_CE_ZERO: &str = include_str!("../data/ce-zero-delay-v1.json");

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

/// The only kinds whose read access scales with **address** width — memories,
/// where the decoder grows with the word count (docs/delay-table.md).
const PER_ADDR_BIT_KINDS: &[&str] = &["mem.rom", "mem.ram"];

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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Entry {
    prop: u64,
    per_bit: u64,
    setup: u64,
    hold: u64,
    access: u64,
    /// Extra read-access time per **address** bit, for memories: a ROM/RAM is
    /// slower the more words it holds, because the address decoder grows. A
    /// 32-word control table and a 32K-word store are not the same part
    /// (docs/delay-table.md).
    per_addr_bit: u64,
    /// Provenance: the part and parameter this row's numbers come from
    /// (`"74LS374 clk->Q 15 typ, tsu 20, th 5"`). Documentation, not timing —
    /// but stored, so `csim` can name its sources without reading a doc file.
    source: String,
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
    /// Extra read access per address bit (memories only).
    #[serde(rename = "perAddrBit")]
    per_addr_bit: u64,
    /// Provenance string (docs/delay-table.md): the part + parameter the row's
    /// numbers were taken from. Optional; carries no timing.
    source: String,
}

impl TimingTable {
    /// Resolve a published table by name (`settings.delayTable`).
    pub fn builtin(name: &str) -> Result<TimingTable, TableError> {
        match name {
            "cs2200-74ls-v1" => TimingTable::from_json(BUILTIN_74LS_V1),
            "cs2200-74ls-v2" => TimingTable::from_json(BUILTIN_74LS_V2),
            "mips-r2000-2um-v1" => TimingTable::from_json(BUILTIN_R2000_2UM),
            "ce-zero-delay-v1" => TimingTable::from_json(BUILTIN_CE_ZERO),
            _ => Err(TableError::Unknown {
                name: name.to_string(),
                available: Self::builtin_names().to_vec(),
            }),
        }
    }

    /// The table names this build ships.
    pub fn builtin_names() -> &'static [&'static str] {
        &[
            "mips-r2000-2um-v1",
            "ce-zero-delay-v1",
            "cs2200-74ls-v2",
            "cs2200-74ls-v1",
        ]
    }

    /// The table new designs should be created with.
    pub fn default_name() -> &'static str {
        "mips-r2000-2um-v1"
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
            if entry.per_addr_bit != 0 && !PER_ADDR_BIT_KINDS.contains(&key.as_str()) {
                issues.push(format!(
                    "components.'{key}': 'perAddrBit' is only meaningful for {PER_ADDR_BIT_KINDS:?}"
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
                        per_addr_bit: e.per_addr_bit,
                        source: e.source,
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
        let e = self.entries.get(type_).cloned().unwrap_or_default();
        let effective = e.prop + e.per_bit * u64::from(bitsize.saturating_sub(1));
        Timing {
            prop: effective,
            setup: e.setup,
            hold: e.hold,
            access: e.access,
        }
    }

    /// The provenance string for a kind's row, e.g.
    /// `"74LS374 clk->Q 15 typ, tsu 20, th 5"` — the part and parameter the
    /// row's numbers were taken from. `None` when the kind has no row.
    pub fn source(&self, type_: &str) -> Option<&str> {
        self.entries.get(type_).map(|e| e.source.as_str())
    }

    /// Address bits needed to hold `words` words (`ceil(log2(words))`, at least
    /// 1). 16 words → 4, 64 → 6, 65536 → 16.
    pub fn addr_bits(words: usize) -> u32 {
        let w = words.max(1);
        (usize::BITS - (w - 1).leading_zeros()).max(1)
    }

    /// Read access for a memory of `words` words: the flat `access` (the part's
    /// published time) plus `perAddrBit` per address line — the decoder term.
    /// A 16-word control table and a 64K-word program store are different parts
    /// (docs/delay-table.md); callers pass the memory's real depth.
    pub fn mem_access(&self, type_: &str, words: usize) -> u64 {
        let e = self.entries.get(type_).cloned().unwrap_or_default();
        e.access + e.per_addr_bit * u64::from(Self::addr_bits(words))
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
            "wiring.reset",
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
        let e = TimingTable::builtin("cs2200-74ls-v9").unwrap_err();
        let msg = e.to_string();
        assert!(msg.contains("cs2200-74ls-v9"), "{msg}");
        assert!(msg.contains("cs2200-74ls-v1"), "{msg}");
        assert!(msg.contains("cs2200-74ls-v2"), "{msg}");
    }

    #[test]
    fn v2_loads_and_is_the_default() {
        let t = TimingTable::builtin("cs2200-74ls-v2").expect("embedded v2 is valid");
        assert_eq!(t.name(), "cs2200-74ls-v2");
        assert_eq!(TimingTable::default_name(), "mips-r2000-2um-v1");
        assert_eq!(
            TimingTable::builtin_names(),
            [
                "mips-r2000-2um-v1",
                "ce-zero-delay-v1",
                "cs2200-74ls-v2",
                "cs2200-74ls-v1"
            ]
        );
    }

    /// `ce-zero-delay-v1` is CircuitSim's own model (no delay at all) and is a
    /// *diagnostic*: it must load, be all-zero, and never be the default.
    #[test]
    fn zero_delay_table_is_the_diagnostic_not_the_default() {
        let t = TimingTable::builtin("ce-zero-delay-v1").expect("embedded zero table is valid");
        assert_eq!(t.status(), "DIAGNOSTIC");
        assert_ne!(TimingTable::default_name(), "ce-zero-delay-v1");
        for kind in REQUIRED_KINDS {
            let tm = t.timing(kind, 32);
            assert_eq!(
                (tm.prop, tm.setup, tm.hold, tm.access),
                (0, 0, 0, 0),
                "'{kind}' must be zero"
            );
        }
        assert_eq!(t.mem_access("mem.ram", 65536), 0);
        assert_eq!(t.mem_access("mem.rom", 64), 0);
        assert_eq!(t.wire_delay(10_000), 0);
    }

    /// The R2000 technology: 2.0 µm CMOS logic against board-level SRAM. The point of the
    /// switch is that memory dominates every stage while logic is ~10x cheaper than TTL,
    /// so the single-cycle path (two memory accesses) is ~2.5-3x a pipeline stage (one).
    #[test]
    fn r2000_2um_anchors_are_datasheet_backed() {
        let t = TimingTable::builtin("mips-r2000-2um-v1").unwrap();
        assert_eq!(t.name(), "mips-r2000-2um-v1");
        // Logic is ~10x faster than the 74LS table's 9-10 ns gates.
        assert_eq!(t.timing("gate.nand", 1).prop, 2);
        assert_eq!(t.timing("gate.xor", 1).prop, 4);
        // 32-bit add, and the per-stage register boundary (clk->Q + setup) is 6 ns.
        assert_eq!(t.timing("arith.adder", 32).prop, 39);
        let reg = t.timing("mem.register", 32);
        assert_eq!((reg.prop, reg.setup, reg.hold), (4, 2, 1));
        // Memory keeps a board part's access time: 64K words = 37 ns (~35 ns R2000/12
        // external SRAM), a 32-word register file = 15 ns.
        assert_eq!(t.mem_access("mem.ram", 65536), 37);
        assert_eq!(t.mem_access("mem.ram", 32), 15);
        // Control tables are on-chip at this node.
        assert_eq!(t.mem_access("mem.rom", 16), 6);
        // The property the whole exercise depends on: the adder is *comparable* to a
        // memory access (74LS made it 3x), so no single stage dominates.
        assert!(t.timing("arith.adder", 32).prop < 2 * t.mem_access("mem.ram", 65536));
        for kind in REQUIRED_KINDS {
            assert!(
                !t.source(kind).unwrap_or("").is_empty(),
                "row '{kind}' has no source"
            );
        }
    }

    /// The corrections that make the memory-dominated regime reproducible: 32Kx8 SRAM is
    /// a 62256-70, EPROM is a 27C256-120, and a 32-bit add is a **ripple** 74LS181 chain
    /// (208 ns) — the term a single-cycle machine serializes twice.
    #[test]
    fn v2_anchors_are_datasheet_backed() {
        let t = TimingTable::builtin("cs2200-74ls-v2").unwrap();
        assert_eq!(t.timing("mem.ram", 32).access, 70);
        assert_eq!(t.timing("mem.ram", 32).setup, 30);
        // Read access scales with the address decoder, not just the part: a 16-word
        // control table and a 32K-word program store are different memories.
        assert_eq!(TimingTable::addr_bits(16), 4);
        assert_eq!(TimingTable::addr_bits(32768), 15);
        assert_eq!(t.mem_access("mem.rom", 16), 43);
        assert_eq!(t.mem_access("mem.rom", 32), 50); // 74S288/82S123 max
        assert_eq!(t.mem_access("mem.rom", 64), 57);
        assert_eq!(t.mem_access("mem.rom", 32768), 120); // 27C256-120
                                                         // RAM stays flat: it is one part in every design here, the 62256.
        assert_eq!(t.mem_access("mem.ram", 65536), 70);
        assert_eq!(t.timing("arith.adder", 32).prop, 208);
        let reg = t.timing("mem.register", 32);
        assert_eq!((reg.prop, reg.setup, reg.hold), (15, 20, 5));
        // A 32-bit add costs more than a memory access: that asymmetry is what makes a
        // pipeline (one add per stage) beat a one-cycle machine (two adds per cycle).
        assert!(t.timing("arith.adder", 32).prop > t.timing("mem.ram", 32).access);
        // Every row names where its numbers came from.
        for kind in REQUIRED_KINDS {
            let src = t.source(kind).unwrap_or("");
            assert!(!src.is_empty(), "v2 row '{kind}' has no source");
        }
        assert!(t.source("mem.ram").unwrap().contains("62256"));
        assert!(t.source("mem.register").unwrap().contains("74LS374"));
        // Provenance is documentation: an unknown field is still rejected, but
        // `source` is a known field (this table is rejected for *missing
        // required kinds*, which is a semantic error, not a parse error).
        let with_source = r#"{
            "name": "t", "units": "ns", "wire": { "num": 1, "den": 10 },
            "components": { "mem.rom": { "access": 5, "source": "27C256-120" } }
        }"#;
        match TimingTable::from_json(with_source) {
            Err(TableError::Json(e)) => panic!("'source' must be a known field: {e}"),
            Err(TableError::Invalid { .. }) => {}
            Err(other) => panic!("unexpected: {other}"),
            Ok(_) => panic!("expected the missing-kind validation to fire"),
        }
    }

    #[test]
    fn per_addr_bit_is_only_meaningful_for_memories() {
        let mut v: serde_json::Value = serde_json::from_str(BUILTIN_74LS_V2).unwrap();
        v["components"]["gate.not"]["perAddrBit"] = serde_json::json!(3);
        let TableError::Invalid { issues, .. } =
            TimingTable::from_json(&v.to_string()).unwrap_err()
        else {
            panic!("expected Invalid");
        };
        assert!(
            issues.iter().any(|i| i.contains("perAddrBit")),
            "{issues:?}"
        );
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
