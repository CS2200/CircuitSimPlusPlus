//! Golden event-trace suite (BACKEND.md task B11; DESIGN.md §4.6).
//!
//! Every positive fixture runs a pinned scenario on the delay engine and
//! must reproduce its pinned `trace_hash` — the determinism tripwire:
//! a determinism-breaking change (HashMap iteration in an eval path,
//! platform-dependent ordering, RNG, wall-clock in eval) flips a hash
//! and fails CI. Negative fixtures must produce their error class.
//!
//! Fixture regeneration: `python3 tests/gen/gen_fixtures.py`. Hash
//! re-blessing after an *intentional* engine-semantics change:
//! `CSIM_BLESS=1 cargo test -p csim-core --test golden` prints the new
//! table to paste below.

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
        trace_hash: 0xa5c0_f9e7_68e3_d220,
    },
    Scenario {
        fixture: "fsm.csx",
        half: 1000,
        cycles: 4,
        pokes: &[("car", 1, 0)],
        t_obs: 49,
        trace_hash: 0x7d36_e627_c0b0_d24a,
    },
    Scenario {
        fixture: "alu.csx",
        half: 1000,
        cycles: 1,
        pokes: &[("a", 7, 0), ("b", 3, 0), ("op", 0, 0)],
        t_obs: 0,
        trace_hash: 0x39f2_6b14_4c38_8a10,
    },
];

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
        assert_eq!(hash, s.trace_hash, "{}: trace hash drifted (§4.6)", s.fixture);
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
        (7, 3, 0, 10),          // add
        (7, 3, 1, 0xFFFF_FFFC), // nand
        (7, 3, 2, 56),          // sll
        (7, 3, 3, 0),           // srl
        (0xDEAD_BEEF, 0, 4, 0xDEAD_BEEF), // pass A
        (0xF0F0_F0F0, 0, 5, 0), // pass B
    ];
    for &(a, b, op, y) in checks {
        let doc = load("alu.csx");
        let mut cfg = autograde::GradeConfig {
            mode: csim_core::api::SimMode::Zero,
            ..GradeConfig_default()
        };
        cfg.limits.max_cycles = 1;
        cfg.pokes = vec![
            autograde::Poke { target: "a".into(), value: a, at: 0 },
            autograde::Poke { target: "b".into(), value: b, at: 0 },
            autograde::Poke { target: "op".into(), value: op, at: 0 },
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

#[allow(clippy::redundant_clone)]
fn GradeConfig_default() -> autograde::GradeConfig {
    autograde::GradeConfig::default()
}

#[test]
fn fixture_fsm_alternates() {
    // car held 1: (ns, ew) = (1,0), (0,1), (1,0), (0,1) over cycles 1-4.
    for n in 1..=4u64 {
        let doc = load("fsm.csx");
        let mut cfg = autograde::GradeConfig::default();
        cfg.limits.max_cycles = n;
        cfg.pokes = vec![autograde::Poke { target: "car".into(), value: 1, at: 0 }];
        let (ns, ew) = (n % 2, 1 - n % 2);
        cfg.assertions = vec![
            autograde::parse_assertion(&format!("probe('ns_green') == {ns}")).unwrap(),
            autograde::parse_assertion(&format!("probe('ew_green') == {ew}")).unwrap(),
            autograde::parse_assertion("violations == 0").unwrap(),
        ];
        let out = autograde::grade(&doc, &cfg).unwrap();
        assert_eq!(out.outcome, autograde::GradeOutcome::Passed, "fsm cycle {n}");
    }
}

#[test]
fn negative_fixtures_halt_as_advertised() {
    // floating-read: exit 5 via the delay engine.
    let doc = load("neg-floating-read.csx");
    let mut cfg = autograde::GradeConfig::default();
    cfg.limits.max_cycles = 2;
    let out = autograde::grade(&doc, &cfg).unwrap();
    assert_eq!(out.outcome, autograde::GradeOutcome::FloatingRead);

    // contention: bus is X; an equality assertion must fail (exit 1).
    let doc = load("neg-contention.csx");
    let mut cfg = autograde::GradeConfig {
        mode: csim_core::api::SimMode::Zero,
        ..autograde::GradeConfig::default()
    };
    cfg.limits.max_cycles = 1;
    cfg.assertions = vec![autograde::parse_assertion("probe('bus') == 0").unwrap()];
    let out = autograde::grade(&doc, &cfg).unwrap();
    assert_eq!(out.outcome, autograde::GradeOutcome::AssertionFailed);

    // oscillation: exit 4 in zero mode.
    let doc = load("neg-oscillation.csx");
    let mut cfg = autograde::GradeConfig {
        mode: csim_core::api::SimMode::Zero,
        ..autograde::GradeConfig::default()
    };
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
    cfg.pokes = vec![autograde::Poke { target: "d".into(), value: 1, at: 3990 }];
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
