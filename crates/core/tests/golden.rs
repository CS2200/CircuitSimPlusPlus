//! Golden event-trace suite (BACKEND.md task B11; DESIGN.md §4.6).
//!
//! Every positive fixture runs a pinned scenario on the delay engine and
//! must reproduce its pinned `trace_hash` — the determinism tripwire:
//! a determinism-breaking change (HashMap iteration in an eval path,
//! platform-dependent ordering, RNG, wall-clock in eval) flips a hash
//! and fails CI. Negative fixtures must produce their error class.
//!
//! Fixture regeneration: `python3 tests/gen/gen_fixtures.py` (+ gen_cpus.py);
//! `node scripts/check-fixtures.mjs` fails CI if the committed files drift from
//! their generators. Hash re-blessing after an *intentional* engine-semantics
//! change: `CSIM_BLESS=1 cargo test -p csim-core --test golden -- --nocapture`
//! *prints* the new table — paste it below (the file is not rewritten).
//!
//! Last re-blessed twice in one batch. First by UI_OVERHAUL §93: `mem.register`/
//! `mem.ram` carry the `rst` pin again (optional, unwired reads deasserted), so
//! every register/RAM owns one more singleton net and the net ids the hash mixes
//! shift. Then by the splitter fix: a splitter no longer ECHOES its bus back onto
//! its own `bus` pin (CE pushes a fanout only when it changes the value, and pushes
//! the bus only with its own last bus value, which starts `Z`), and it drives a
//! fanout only where nothing else does — so the three splitter-using fixtures see
//! fewer events. In both cases `t_obs` did not move and the
//! architectural checks (`cpu_fixtures_compute_the_program`, `fixture_alu_computes`)
//! still pass — the drift is events, not results.
//!
//! Re-blessed again by the idle-bus fix: a part now waits for a `Z` input only if its own
//! consume table reads it *and* the value is still on its way (`net_in_flight`), so a `Z`
//! on a pin a part never reads no longer stalls it. Only `alu.csx` moved — its 8-way mux
//! has six unconnected inputs — and again `t_obs` held and the architectural checks pass:
//! the drift is one fewer spurious hold, not a different result.

use csim_core::autograde;
use csim_core::delay::DelayEngine;
use csim_core::format::load_document;
use csim_core::timing_table::TimingTable;
use csim_core::value::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..", "/tests/fixtures");

/// A pinned scenario: pokes, run length, expected observables.
struct Scenario {
    fixture: &'static str,
    half: u64,
    cycles: u64,
    pokes: &'static [(&'static str, u64, u64)], // (pin, value, at ns)
    t_obs: u64,
    trace_hash: u64,
}

const SCENARIOS: &[Scenario] = &[
    Scenario {
        fixture: "sanity.csx",
        half: 1000,
        cycles: 3,
        pokes: &[],
        t_obs: 39,
        trace_hash: 0x44a3_115d_908c_aa32,
    },
    Scenario {
        fixture: "fsm.csx",
        half: 1000,
        cycles: 4,
        pokes: &[("car", 1, 0)],
        t_obs: 40,
        trace_hash: 0xfa28_bcbe_f38e_aeaf,
    },
    Scenario {
        fixture: "alu.csx",
        half: 1000,
        cycles: 1,
        pokes: &[("a", 7, 0), ("b", 3, 0), ("op", 0, 0)],
        t_obs: 0,
        trace_hash: 0x13d4_9d0e_fdb3_5205,
    },
    Scenario {
        fixture: "multicycle.csx",
        half: 500,
        cycles: 100,
        pokes: &[],
        t_obs: 205,
        trace_hash: 0xb009_1cba_432c_f5c7,
    },
    Scenario {
        fixture: "pipeline5.csx",
        half: 500,
        cycles: 100,
        pokes: &[],
        t_obs: 205,
        trace_hash: 0x3221_6d5d_e6c2_3e29,
    },
];

/// The CPU fixtures run the same program to the same architectural state
/// (the course's CPI lesson is in the timing numbers, not the values).
#[test]
fn cpu_fixtures_compute_the_program() {
    for fixture in ["multicycle.csx", "pipeline5.csx"] {
        let doc = load(fixture);
        let mut cfg = autograde::GradeConfig::default();
        cfg.limits.max_cycles = 100;
        cfg.assertions = [
            "probe('sum') == 10",
            "probe('r4') == 10",
            "probe('r5') == 20",
            "mem('dmem')[0] == 10",
            "violations == 0",
        ]
        .iter()
        .map(|a| autograde::parse_assertion(a).unwrap())
        .collect();
        let out = autograde::grade(&doc, &cfg).unwrap();
        assert_eq!(
            out.outcome,
            autograde::GradeOutcome::Passed,
            "{fixture}: {:?}",
            out.report.assertions
        );
    }
}

/// Regression (B11): a static cone fed by a splitter (register →
/// splitter → decoder → gates) must settle to the correct values in the
/// delay engine even when its inputs never change after power-on. A
/// splitter's InOut driver listing used to fake a self-loop in
/// levelization, seeding the cone to 0 and freezing it there.
#[test]
fn delay_power_on_static_splitter_cone() {
    let json = r##"{
        "format": "circuitsim-plus-plus", "version": 3, "name": "t",
        "settings": {"clockHz": 1, "delayTable": "cs2200-74ls-v1"},
        "circuits": [{ "name": "main", "components": [
            {"id": "clk", "type": "wiring.clock", "pos": [0, 0]},
            {"id": "z", "type": "wiring.constant", "pos": [0, 0]},
            {"id": "z32", "type": "wiring.constant", "pos": [0, 0], "attrs": {"bitsize": 32}},
            {"id": "ir", "type": "mem.register", "pos": [0, 0], "name": "ir", "attrs": {"bitsize": 32}},
            {"id": "v", "type": "mem.register", "pos": [0, 0], "name": "v"},
            {"id": "sp", "type": "wiring.splitter", "pos": [0, 0],
             "attrs": {"splits": {"op": [29, 30, 31], "rest": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]}}},
            {"id": "dec", "type": "plexers.decoder", "pos": [0, 0], "attrs": {"inputBits": 3}},
            {"id": "a", "type": "gate.and", "pos": [0, 0]},
            {"id": "n", "type": "gate.not", "pos": [0, 0]},
            {"id": "p", "type": "wiring.probe", "pos": [0, 0], "name": "p"}
        ], "wires": [
            {"a": {"comp": "clk", "pin": "out"}, "b": {"comp": "ir", "pin": "clk"}},
            {"a": {"comp": "z", "pin": "out"}, "b": {"comp": "ir", "pin": "en"}},
            {"a": {"comp": "z32", "pin": "out"}, "b": {"comp": "ir", "pin": "d"}},
            {"a": {"comp": "clk", "pin": "out"}, "b": {"comp": "v", "pin": "clk"}},
            {"a": {"comp": "z", "pin": "out"}, "b": {"comp": "v", "pin": "en"}},
            {"a": {"comp": "z", "pin": "out"}, "b": {"comp": "v", "pin": "d"}},
            {"a": {"comp": "ir", "pin": "q"}, "b": {"comp": "sp", "pin": "bus"}},
            {"a": {"comp": "sp", "pin": "op"}, "b": {"comp": "dec", "pin": "in"}},
            {"a": {"comp": "dec", "pin": "out6"}, "b": {"comp": "a", "pin": "in0"}},
            {"a": {"comp": "v", "pin": "q"}, "b": {"comp": "a", "pin": "in1"}},
            {"a": {"comp": "a", "pin": "out"}, "b": {"comp": "n", "pin": "in"}},
            {"a": {"comp": "n", "pin": "out"}, "b": {"comp": "p", "pin": "in"}}
        ]}]
    }"##;
    let doc = load_document(json.as_bytes()).unwrap();
    let nl = csim_core::netlist::build(&doc).unwrap();
    let table = TimingTable::builtin("cs2200-74ls-v1").unwrap();
    let mut eng = DelayEngine::new(nl, 1000, &table).unwrap();
    eng.run(1).unwrap();
    assert_eq!(eng.named_value("p"), Some(Value::from_u64(1, 1)));
}

/// Regression (B11): chained splitters (split → split on one net) carry
/// the value in both engines.
#[test]
fn chained_splitters_carry_values() {
    let json = r##"{
        "format": "circuitsim-plus-plus", "version": 3, "name": "t",
        "settings": {"clockHz": 1, "delayTable": "cs2200-74ls-v1"},
        "circuits": [{ "name": "main", "components": [
            {"id": "src", "type": "wiring.constant", "pos": [0, 0], "attrs": {"value": "d", "bitsize": 4}},
            {"id": "s1", "type": "wiring.splitter", "pos": [0, 0],
             "attrs": {"splits": {"lo": [0, 1], "hi": [2, 3]}}},
            {"id": "s2", "type": "wiring.splitter", "pos": [0, 0],
             "attrs": {"splits": {"b0": [0], "b1": [1]}}},
            {"id": "p0", "type": "wiring.probe", "pos": [0, 0], "name": "p0"},
            {"id": "p1", "type": "wiring.probe", "pos": [0, 0], "name": "p1"},
            {"id": "ph", "type": "wiring.probe", "pos": [0, 0], "name": "ph", "attrs": {"bitsize": 2}}
        ], "wires": [
            {"a": {"comp": "src", "pin": "out"}, "b": {"comp": "s1", "pin": "bus"}},
            {"a": {"comp": "s1", "pin": "lo"}, "b": {"comp": "s2", "pin": "bus"}},
            {"a": {"comp": "s2", "pin": "b0"}, "b": {"comp": "p0", "pin": "in"}},
            {"a": {"comp": "s2", "pin": "b1"}, "b": {"comp": "p1", "pin": "in"}},
            {"a": {"comp": "s1", "pin": "hi"}, "b": {"comp": "ph", "pin": "in"}}
        ]}]
    }"##;
    let doc = load_document(json.as_bytes()).unwrap();
    let mut cfg = autograde::GradeConfig::default();
    cfg.limits.max_cycles = 1;
    cfg.assertions = ["probe('p0') == 1", "probe('p1') == 0", "probe('ph') == 3"]
        .iter()
        .map(|a| autograde::parse_assertion(a).unwrap())
        .collect();
    let out = autograde::grade(&doc, &cfg).unwrap();
    assert_eq!(
        out.outcome,
        autograde::GradeOutcome::Passed,
        "{:?}",
        out.report.assertions
    );
}

fn load(fixture: &str) -> csim_core::format::Document {
    let bytes = std::fs::read(format!("{FIXTURES}/{fixture}")).expect("fixture readable");
    load_document(&bytes).expect("fixture validates")
}

fn run_scenario(s: &Scenario) -> (u64, u64) {
    let doc = load(s.fixture);
    let nl = csim_core::netlist::build(&doc).expect("fixture netlists");
    let table = TimingTable::builtin(&doc.settings.delay_table).unwrap();
    let widths: Vec<u32> = s
        .pokes
        .iter()
        .map(|(name, _, _)| {
            nl.comps
                .iter()
                .find(|c| c.type_ == "wiring.pin" && c.name.as_deref() == Some(*name))
                .and_then(|c| c.pins.first())
                .map(|p| p.width)
                .unwrap_or(1)
        })
        .collect();
    let mut eng = DelayEngine::new(nl, s.half, &table).expect("engine builds");
    for (&(pin, v, at), &w) in s.pokes.iter().zip(&widths) {
        assert!(eng.poke_at(pin, Value::from_u64(w, v), at), "poke {pin}");
    }
    eng.run(s.cycles).expect("scenario runs clean");
    (eng.t_obs(), eng.trace_hash())
}

/// Fixtures are committed artifacts of `tests/gen/*.py` (plus the
/// hand-authored `sanity.csx`), and the loader migrates older versions
/// silently — so a fixture left behind at the previous version would otherwise
/// go unnoticed, and this suite would quietly exercise the migration path
/// rather than today's parser. Assert the raw files are written at the current
/// version.
#[test]
fn fixtures_are_written_at_the_current_version() {
    let current = csim_core::format::FORMAT_VERSION;
    let mut checked = 0;
    for entry in std::fs::read_dir(FIXTURES).expect("fixtures dir read") {
        let path = entry.expect("fixture dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("csx") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("fixture read");
        let version = serde_json::from_str::<serde_json::Value>(&text)
            .expect("fixture parses as JSON")
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_else(|| panic!("{} has no version field", path.display()));
        assert_eq!(
            version,
            u64::from(current),
            "{} is written at version {version}; regenerate the fixtures for version {current} \
             (`python3 tests/gen/gen_fixtures.py && python3 tests/gen/gen_cpus.py`)",
            path.display()
        );
        checked += 1;
    }
    assert!(checked >= 5, "only {checked} fixtures were checked");
}

#[test]
fn golden_traces_are_pinned() {
    let bless = std::env::var("CSIM_BLESS").is_ok();
    let mut table = String::from("Scenario { fixture, half, cycles, pokes, t_obs, trace_hash }");
    for s in SCENARIOS {
        let (t_obs, hash) = run_scenario(s);
        if bless {
            table.push_str(&format!(
                "\n  {:<16} half={:<5} cycles={:<3} t_obs={:<4} hash={:#018x}",
                s.fixture, s.half, s.cycles, t_obs, hash
            ));
            continue;
        }
        assert_eq!(t_obs, s.t_obs, "{}: T_obs drifted", s.fixture);
        assert_eq!(
            hash, s.trace_hash,
            "{}: trace hash drifted (§4.6)",
            s.fixture
        );
    }
    if bless {
        eprintln!("\n{table}\n");
    }
}

/// The same scenario twice must hash identically (in-process twin of the
/// cross-machine property; cheap to always run).
#[test]
fn golden_traces_are_repeatable() {
    for s in SCENARIOS {
        let a = run_scenario(s);
        let b = run_scenario(s);
        assert_eq!(a, b, "{}: same run twice differs (§4.6)", s.fixture);
    }
}

/// Functional content of the fixtures (independent of hashes).
#[test]
fn fixture_alu_computes() {
    let checks: &[(u64, u64, u64, u64)] = &[
        (7, 3, 0, 10),                    // add
        (7, 3, 1, 0xFFFF_FFFC),           // nand
        (7, 3, 2, 56),                    // sll
        (7, 3, 3, 0),                     // srl
        (0xDEAD_BEEF, 0, 4, 0xDEAD_BEEF), // pass A
        (0xF0F0_F0F0, 0, 5, 0),           // pass B
    ];
    for &(a, b, op, y) in checks {
        let doc = load("alu.csx");
        let mut cfg = autograde::GradeConfig::default();
        cfg.limits.max_cycles = 1;
        cfg.pokes = vec![
            autograde::Poke {
                target: "a".into(),
                value: a,
                at: 0,
            },
            autograde::Poke {
                target: "b".into(),
                value: b,
                at: 0,
            },
            autograde::Poke {
                target: "op".into(),
                value: op,
                at: 0,
            },
        ];
        cfg.assertions = vec![autograde::parse_assertion(&format!("probe('y') == {y}")).unwrap()];
        let out = autograde::grade(&doc, &cfg).unwrap();
        assert_eq!(
            out.outcome,
            autograde::GradeOutcome::Passed,
            "alu a={a:#x} b={b:#x} op={op} -> {y:#x}"
        );
    }
}

#[test]
fn fixture_fsm_alternates() {
    // car held 1: (ns, ew) = (1,0), (0,1), (1,0), (0,1) over cycles 1-4.
    for n in 1..=4u64 {
        let doc = load("fsm.csx");
        let mut cfg = autograde::GradeConfig::default();
        cfg.limits.max_cycles = n;
        cfg.pokes = vec![autograde::Poke {
            target: "car".into(),
            value: 1,
            at: 0,
        }];
        let (ns, ew) = (n % 2, 1 - n % 2);
        cfg.assertions = vec![
            autograde::parse_assertion(&format!("probe('ns_green') == {ns}")).unwrap(),
            autograde::parse_assertion(&format!("probe('ew_green') == {ew}")).unwrap(),
            autograde::parse_assertion("violations == 0").unwrap(),
        ];
        let out = autograde::grade(&doc, &cfg).unwrap();
        assert_eq!(
            out.outcome,
            autograde::GradeOutcome::Passed,
            "fsm cycle {n}"
        );
    }
}

#[test]
fn negative_fixtures_halt_as_advertised() {
    // floating-read: **not a fault** since contract v1.4. The value it reads is `X` —
    // unknown — and the run carries on, so the verdict is the assertion's (an `X` never
    // equals a literal). `pause_on_unknown` is what asks to be stopped instead, which is
    // the editor's setting, not a grader's.
    let doc = load("neg-floating-read.csx");
    let mut cfg = autograde::GradeConfig::default();
    cfg.limits.max_cycles = 2;
    cfg.assertions = vec![autograde::parse_assertion("probe('r') == 0").unwrap()];
    let out = autograde::grade(&doc, &cfg).unwrap();
    assert_eq!(out.outcome, autograde::GradeOutcome::AssertionFailed);
    let mut cfg = autograde::GradeConfig::default();
    cfg.limits.max_cycles = 2;
    cfg.pause_on_unknown = true;
    let out = autograde::grade(&doc, &cfg).unwrap();
    assert_eq!(out.outcome, autograde::GradeOutcome::FloatingRead);
    assert_eq!(out.outcome.exit_code(), autograde::EXIT_FLOATING_READ);

    // contention: bus is X; an equality assertion must fail (exit 1).
    let doc = load("neg-contention.csx");
    let mut cfg = autograde::GradeConfig::default();
    cfg.limits.max_cycles = 1;
    cfg.assertions = vec![autograde::parse_assertion("probe('bus') == 0").unwrap()];
    let out = autograde::grade(&doc, &cfg).unwrap();
    assert_eq!(out.outcome, autograde::GradeOutcome::AssertionFailed);

    // oscillation: exit 4.
    let doc = load("neg-oscillation.csx");
    let mut cfg = autograde::GradeConfig::default();
    cfg.limits.max_cycles = 2;
    let out = autograde::grade(&doc, &cfg).unwrap();
    assert_eq!(out.outcome, autograde::GradeOutcome::Oscillation);

    // setup violation: warning recorded, run still completes.
    let doc = load("neg-setup-violation.csx");
    let mut cfg = autograde::GradeConfig {
        clock_half_period: 1000,
        ..autograde::GradeConfig::default()
    };
    cfg.limits.max_cycles = 2;
    cfg.pokes = vec![autograde::Poke {
        target: "d".into(),
        value: 1,
        at: 3990,
    }];
    cfg.assertions = vec![autograde::parse_assertion("violations == 1").unwrap()];
    let out = autograde::grade(&doc, &cfg).unwrap();
    assert_eq!(out.outcome, autograde::GradeOutcome::Passed);

    // bitsize mismatch: malformed file, exit 6.
    let doc = load("neg-bitsize-mismatch.csx");
    let mut cfg = autograde::GradeConfig::default();
    cfg.limits.max_cycles = 1;
    let out = autograde::grade(&doc, &cfg).unwrap();
    assert_eq!(out.outcome, autograde::GradeOutcome::MalformedFile);
}
