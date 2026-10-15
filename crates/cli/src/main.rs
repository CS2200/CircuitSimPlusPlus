//! `csim` — headless CLI / Gradescope autograder runner (DESIGN.md §8).
//!
//! Pure Rust, statically linkable (`x86_64-unknown-linux-musl`), no webview.
//! JSON-in/JSON-out: every subcommand prints JSON to stdout; `run` writes
//! the full §8.2 report to `--json` (or stdout). Exit codes are the §8.2
//! taxonomy (`csim_core::autograde`).

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};

use csim_core::api::{LoadError, LoadErrorKind};
use csim_core::autograde::{self, GradeConfig, LoadSource, RunLimits, TestSpec};
use csim_core::format::{self, Document};
use csim_core::timing_table::TimingTable;

/// CircuitSim++ headless runner.
#[derive(Parser)]
#[command(name = "csim", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run a circuit headless and grade it (DESIGN.md §8.1).
    Run(RunArgs),
    /// Validate a .csx file; print all load errors (DESIGN.md §5.2).
    Validate {
        /// Circuit file (.csx).
        file: PathBuf,
    },
    /// Timing analysis: observed (DTA) timing is primary — a grading
    /// engine run of --cycles cycles (default 1000). STA is available
    /// via --sta, clearly labeled informational (DESIGN.md §4.4, F9).
    Timing {
        /// Circuit file (.csx).
        file: PathBuf,
        /// Number of top critical paths to report.
        #[arg(long, default_value_t = 10)]
        paths: usize,
        /// Cycles for the observed (DTA) run (default 1000; 0 disables).
        #[arg(long)]
        cycles: Option<u64>,
        /// Include informational STA (structural bound — may include
        /// paths the design never uses).
        #[arg(long)]
        sta: bool,
        /// Write the JSON output to this path instead of stdout.
        #[arg(long)]
        json: Option<PathBuf>,
    },
    /// Save a self-contained snapshot (circuit + engine state) after a run.
    Snapshot {
        /// Circuit file (.csx).
        file: PathBuf,
        /// Output snapshot path.
        #[arg(long)]
        out: PathBuf,
        /// Run this many cycles before snapshotting.
        #[arg(long, default_value_t = 0)]
        cycles: u64,
        /// Clock half-period in ns.
        #[arg(long)]
        clock_half_period_ns: Option<u64>,
    },
    /// Resume from a snapshot and continue running; prints named values.
    Resume {
        /// Snapshot file (self-contained: embeds the circuit).
        snapshot: PathBuf,
        /// Run this many cycles after resuming.
        #[arg(long, default_value_t = 0)]
        cycles: u64,
        /// Write the JSON output to this path instead of stdout.
        #[arg(long)]
        json: Option<PathBuf>,
    },
}

#[derive(Args)]
struct RunArgs {
    /// Circuit file (.csx).
    file: PathBuf,
    /// Preload a named memory: --load name=file.hex (repeatable; §8.1).
    /// Paths resolve against the current directory; overrides the file's
    /// own `autoload` attr for that memory.
    #[arg(long, value_name = "NAME=FILE")]
    load: Vec<String>,
    /// Cycle limit.
    #[arg(long)]
    cycles: Option<u64>,
    /// Wall-clock timeout, e.g. 60s, 500ms, 2m.
    #[arg(long)]
    timeout: Option<String>,
    /// RSS guard, MiB (§11).
    #[arg(long)]
    rss_cap_mb: Option<u64>,
    /// Assertion, e.g. --assert "probe('result') == 0x2A" (repeatable; §8.2).
    #[arg(long = "assert")]
    asserts: Vec<String>,
    /// JSON test-spec file (§8.3); flags above override it.
    #[arg(long)]
    spec: Option<PathBuf>,
    /// Course baseline est_time for speedup_vs_baseline.
    #[arg(long)]
    baseline_est_time: Option<u64>,
    /// Exit 2 when the run consumes its cycle budget without halting.
    #[arg(long)]
    expect_halt: bool,
    /// Clock half-period in ns (delay mode).
    #[arg(long)]
    clock_half_period_ns: Option<u64>,
    /// Include informational STA in the report (§4.4).
    #[arg(long)]
    sta: bool,
    /// Top-k observed critical paths in the report.
    #[arg(long, default_value_t = 10)]
    paths: usize,
    /// Allow autoload/preload paths outside the circuit file's directory
    /// tree (§11 — sandboxed by default).
    #[arg(long)]
    allow_outside_autoload: bool,
    /// Write the JSON report to this path (§8.2).
    #[arg(long)]
    json: Option<PathBuf>,
}

fn io_error(file: &Path, e: &std::io::Error) -> Vec<LoadError> {
    vec![LoadError {
        kind: LoadErrorKind::Io,
        message: format!("{}: {e}", file.display()),
        circuit: String::new(),
        comp_id: None,
        wire_idx: None,
    }]
}

fn print_or_write(json: &str, out: Option<&Path>) -> ExitCode {
    match out {
        Some(path) => match std::fs::write(path, format!("{json}\n")) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("csim: {}: {e}", path.display());
                ExitCode::from(exit::MALFORMED_FILE)
            }
        },
        None => {
            println!("{json}");
            ExitCode::SUCCESS
        }
    }
}

/// `csim validate <file>`: parse + validate + netlist-build (F8: a
/// netlist-level load error such as a bitsize mismatch is a validation
/// failure too), print the complete error list as JSON. Exit 0 when
/// valid, `MALFORMED_FILE` otherwise.
fn validate(file: &Path) -> ExitCode {
    let errors = match std::fs::read(file) {
        Ok(bytes) => match format::load_document(&bytes) {
            Ok(doc) => match csim_core::netlist::build(&doc) {
                Ok(_) => Vec::new(),
                Err(errors) => errors,
            },
            Err(errors) => errors,
        },
        Err(e) => io_error(file, &e),
    };
    let report = serde_json::json!({ "ok": errors.is_empty(), "errors": errors });
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("JSON serialization cannot fail")
    );
    if errors.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(exit::MALFORMED_FILE)
    }
}

/// Parse "60s" / "500ms" / "2m" / bare seconds.
fn parse_duration(text: &str) -> Result<Duration, String> {
    let (num, mult) = if let Some(n) = text.strip_suffix("ms") {
        (n, 1)
    } else if let Some(n) = text.strip_suffix('s') {
        (n, 1000)
    } else if let Some(n) = text.strip_suffix('m') {
        (n, 60_000)
    } else {
        (text, 1000)
    };
    let n: u64 = num
        .parse()
        .map_err(|_| format!("bad timeout '{text}' (e.g. 60s, 500ms, 2m)"))?;
    Ok(Duration::from_millis(n * mult))
}

/// §11 sandbox: `path` must stay under `root` unless relaxed.
fn sandbox_check(root: &Path, path: &Path, relaxed: bool) -> Result<PathBuf, String> {
    let joined = root.join(path);
    if relaxed {
        return Ok(joined);
    }
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("{}: {e}", root.display()))?;
    let canon = joined
        .canonicalize()
        .map_err(|e| format!("{}: {e}", joined.display()))?;
    if canon.starts_with(&canon_root) {
        Ok(canon)
    } else {
        Err(format!(
            "{}: outside the circuit's directory tree (§11; --allow-outside-autoload to relax)",
            joined.display()
        ))
    }
}

/// Collect `autoload` attrs, addressed by HIERARCHICAL memory name
/// (contract v1.1, F12 — e.g. `u1/imem` for a memory nested in a
/// subcircuit instance); explicit --load entries win by the same
/// hierarchical name. Paths resolve against the circuit file's dir and
/// stay inside its tree (§11).
fn autoloads(
    doc: &Document,
    circuit_dir: &Path,
    explicit: &[String],
    relaxed: bool,
) -> Result<Vec<(String, LoadSource)>, String> {
    let mut out = Vec::new();
    for (name, rel) in csim_core::netlist::autoload_memories(doc) {
        if explicit
            .iter()
            .any(|l| l.split_once('=').is_some_and(|(n, _)| n == name))
        {
            continue; // explicit --load wins
        }
        let path = sandbox_check(circuit_dir, Path::new(&rel), relaxed)?;
        out.push((name, LoadSource::File(path)));
    }
    Ok(out)
}

/// Build the GradeConfig from flags (overriding the optional spec).
fn run_config(args: &RunArgs) -> Result<GradeConfig, String> {
    let mut cfg = match &args.spec {
        Some(path) => {
            let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
            let dir = path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf();
            TestSpec::from_json(&bytes)?.into_config(&dir)?
        }
        None => GradeConfig::default(),
    };
    if let Some(c) = args.cycles {
        cfg.limits.max_cycles = c;
    }
    if let Some(t) = &args.timeout {
        cfg.limits.timeout = Some(parse_duration(t)?);
    }
    if let Some(mb) = args.rss_cap_mb {
        cfg.limits.rss_cap_bytes = Some(mb * 1024 * 1024);
    }
    for l in &args.load {
        let (name, file) = l
            .split_once('=')
            .ok_or_else(|| format!("--load expects NAME=FILE, got '{l}'"))?;
        cfg.loads
            .push((name.to_string(), LoadSource::File(PathBuf::from(file))));
    }
    for a in &args.asserts {
        cfg.assertions
            .push(autograde::parse_assertion(a).map_err(|e| e.to_string())?);
    }
    if let Some(b) = args.baseline_est_time {
        cfg.baseline_est_time = Some(b);
    }
    cfg.expect_halt |= args.expect_halt;
    if let Some(h) = args.clock_half_period_ns {
        cfg.clock_half_period = h;
    }
    cfg.include_sta |= args.sta;
    cfg.top_k = args.paths;
    if cfg.limits.max_cycles == 0 {
        return Err("cycle limit is 0 — pass --cycles or a spec".to_string());
    }
    Ok(cfg)
}

/// `csim run`: the grading flow (§8.1/§8.2).
fn run(args: &RunArgs) -> ExitCode {
    // F10: one malformed-file JSON shape everywhere — the full §8.2
    // Report with halt_reason "malformed-file" and the error list in
    // `errors` (exit code unchanged: 6).
    let emit_malformed = |errors: Vec<LoadError>| -> ExitCode {
        let report = autograde::malformed_report(errors, "unknown");
        let json = serde_json::to_string_pretty(&report).expect("report serializes");
        match print_or_write(&json, args.json.as_deref()) {
            ExitCode::SUCCESS => ExitCode::from(exit::MALFORMED_FILE),
            other => other,
        }
    };
    let bytes = match std::fs::read(&args.file) {
        Ok(b) => b,
        Err(e) => return emit_malformed(io_error(&args.file, &e)),
    };
    let doc = match format::load_document(&bytes) {
        Ok(d) => d,
        Err(errors) => return emit_malformed(errors),
    };
    let mut cfg = match run_config(args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("csim: {e}");
            return ExitCode::from(exit::USAGE);
        }
    };
    let circuit_dir = args
        .file
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    match autoloads(&doc, &circuit_dir, &args.load, args.allow_outside_autoload) {
        Ok(mut pre) => {
            pre.append(&mut cfg.loads);
            cfg.loads = pre;
        }
        Err(e) => {
            eprintln!("csim: {e}");
            return ExitCode::from(exit::USAGE);
        }
    }
    match autograde::grade(&doc, &cfg) {
        Ok(out) => {
            let json = serde_json::to_string_pretty(&out.report).expect("report serializes");
            let code = out.outcome.exit_code() as u8;
            match print_or_write(&json, args.json.as_deref()) {
                ExitCode::SUCCESS => ExitCode::from(code),
                other => other,
            }
        }
        Err(e) => {
            eprintln!("csim: {e}");
            ExitCode::from(exit::USAGE)
        }
    }
}

/// `csim timing`: observed/DTA timing primary (default 1000 cycles);
/// STA only behind --sta, labeled informational (F9).
fn timing(
    file: &Path,
    paths: usize,
    cycles: Option<u64>,
    want_sta: bool,
    json_out: Option<&Path>,
) -> ExitCode {
    let doc = match std::fs::read(file)
        .map_err(|e| e.to_string())
        .and_then(|b| format::load_document(&b).map_err(|e| format!("{e:?}")))
    {
        Ok(d) => d,
        Err(e) => {
            eprintln!("csim: {e}");
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let mut out = serde_json::json!({
        "delay_table": format!("{} (DRAFT)", doc.settings.delay_table),
    });

    // -- DTA (primary): run the grading engine --------------------------
    let n = cycles.unwrap_or(1000);
    if n > 0 {
        let cfg = GradeConfig {
            limits: RunLimits {
                max_cycles: n,
                ..RunLimits::default()
            },
            top_k: paths,
            ..GradeConfig::default()
        };
        match autograde::grade(&doc, &cfg) {
            Ok(graded) => {
                out["dta"] = serde_json::json!({
                    "cycles": graded.report.cycles,
                    "t_obs": graded.report.t_obs,
                    "est_time": graded.report.est_time,
                    "top_paths": graded.report.top_paths,
                });
            }
            Err(e) => {
                eprintln!("csim: {e}");
                return ExitCode::from(exit::USAGE);
            }
        }
    }

    // -- STA (informational only, on request) -----------------------------
    if want_sta {
        let nl = match csim_core::netlist::build(&doc) {
            Ok(nl) => nl,
            Err(errors) => {
                eprintln!(
                    "csim: {}",
                    serde_json::to_string(&errors).expect("serializes")
                );
                return ExitCode::from(exit::MALFORMED_FILE);
            }
        };
        let table = match TimingTable::builtin(&doc.settings.delay_table) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("csim: {e}");
                return ExitCode::from(exit::MALFORMED_FILE);
            }
        };
        match csim_core::sta::analyze(&nl, &table, paths) {
            Ok(r) => {
                out["t_sta"] = serde_json::json!(r.t_sta);
                out["sta_note"] = serde_json::json!(
                    "informational structural bound — includes setup time; may include paths your design never uses"
                );
                out["sta_paths"] = r
                    .top_paths
                    .iter()
                    .map(|p| {
                        let (circuit, comp_id) = nl.doc_id(p.endpoint);
                        serde_json::json!({
                            "delay": p.delay,
                            "endpoint": { "circuit": circuit, "comp_id": comp_id },
                            "comps": p.comps.iter().map(|c| {
                                let (cc, ci) = nl.doc_id(*c);
                                serde_json::json!({ "circuit": cc, "comp_id": ci })
                            }).collect::<Vec<_>>(),
                        })
                    })
                    .collect::<Vec<_>>()
                    .into();
            }
            Err(e) => {
                out["t_sta"] = serde_json::Value::Null;
                out["sta_note"] = serde_json::json!(e.to_string());
            }
        }
    }
    let json = serde_json::to_string_pretty(&out).expect("serializes");
    print_or_write(&json, json_out)
}

/// Self-contained snapshot file: circuit + engine state.
fn snapshot(file: &Path, out: &Path, cycles: u64, half: Option<u64>) -> ExitCode {
    let bytes = match std::fs::read(file) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("csim: {}: {e}", file.display());
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let doc = match format::load_document(&bytes) {
        Ok(d) => d,
        Err(errors) => {
            eprintln!(
                "csim: {}",
                serde_json::to_string(&errors).expect("serializes")
            );
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let doc_json = serde_json::to_value(&doc).expect("document serializes");
    let nl = match csim_core::netlist::build(&doc) {
        Ok(nl) => nl,
        Err(errors) => {
            eprintln!(
                "csim: {}",
                serde_json::to_string(&errors).expect("serializes")
            );
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let table = TimingTable::builtin(&doc.settings.delay_table).expect("validated at load");
    let half = half.unwrap_or(1000).max(1);
    let mut eng = match csim_core::delay::DelayEngine::new(nl, half, &table) {
        Ok(e) => e,
        Err(errors) => {
            eprintln!(
                "csim: {}",
                serde_json::to_string(&errors).expect("serializes")
            );
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let run_cycles = match eng.run(cycles) {
        Ok(rep) => rep.cycles,
        Err(h) => {
            eprintln!("csim: halted: {h}");
            return ExitCode::from(autograde::EXIT_ASSERTION_FAILED as u8);
        }
    };
    let state_json = eng.snapshot();
    let file_json = serde_json::json!({
        "format": "csim-snapshot",
        "version": 2,
        "clock_half_period_ns": half,
        "cycles_run": run_cycles,
        "circuit": doc_json,
        "state": serde_json::from_str::<serde_json::Value>(&state_json).expect("state parses"),
    });
    match std::fs::write(
        out,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&file_json).expect("serializes")
        ),
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("csim: {}: {e}", out.display());
            ExitCode::from(exit::MALFORMED_FILE)
        }
    }
}

/// `csim resume`: rebuild from the embedded circuit, restore, continue.
fn resume(snapshot_path: &Path, cycles: u64, json_out: Option<&Path>) -> ExitCode {
    let bytes = match std::fs::read(snapshot_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("csim: {}: {e}", snapshot_path.display());
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let file: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("csim: bad snapshot: {e}");
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    if file["format"] != "csim-snapshot" || file["version"] != 2 {
        eprintln!("csim: not a csim-snapshot v2 file");
        return ExitCode::from(exit::MALFORMED_FILE);
    }
    let doc: Document = match serde_json::from_value(file["circuit"].clone()) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("csim: bad embedded circuit: {e}");
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    // F2: the embedded circuit is untrusted input — run FULL validation
    // before anything is built from it (never panic on load, §11).
    {
        let errors = csim_core::format::validate::validate(&doc);
        if !errors.is_empty() {
            eprintln!(
                "csim: embedded circuit is invalid: {}",
                serde_json::to_string(&errors).expect("serializes")
            );
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    }
    let state = serde_json::to_string(&file["state"]).expect("state serializes");
    let nl = match csim_core::netlist::build(&doc) {
        Ok(nl) => nl,
        Err(errors) => {
            eprintln!(
                "csim: {}",
                serde_json::to_string(&errors).expect("serializes")
            );
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let named_values =
        |nl: &csim_core::netlist::Netlist,
         get: &dyn Fn(&str) -> Option<csim_core::value::Value>| {
            nl.named
                .iter()
                .map(|n| (n.name.clone(), get(&n.name).map(|v| v.to_wire_value())))
                .collect::<Vec<_>>()
        };
    let table = match TimingTable::builtin(&doc.settings.delay_table) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("csim: {e}");
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let half = file["clock_half_period_ns"].as_u64().unwrap_or(1000).max(1);
    let mut eng = match csim_core::delay::DelayEngine::new(nl, half, &table) {
        Ok(e) => e,
        Err(errors) => {
            eprintln!(
                "csim: {}",
                serde_json::to_string(&errors).expect("serializes")
            );
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let out = {
        if let Err(e) = eng.restore(&state) {
            eprintln!("csim: {e}");
            return ExitCode::from(exit::MALFORMED_FILE);
        }
        match eng.run(cycles) {
            Ok(rep) => {
                let vals = named_values(eng.netlist(), &|n| eng.named_value(n));
                serde_json::json!({
                    "cycle": eng.cycle(),
                    "halted": false,
                    "t_obs": rep.t_obs,
                    "trace_hash": rep.trace_hash,
                    "named": vals,
                })
            }
            Err(h) => {
                eprintln!("csim: halted: {h}");
                return ExitCode::from(autograde::EXIT_ASSERTION_FAILED as u8);
            }
        }
    };
    let json = serde_json::to_string_pretty(&out).expect("serializes");
    print_or_write(&json, json_out)
}

/// Exit codes (DESIGN.md §8.2 — the grading taxonomy lives in
/// `csim_core::autograde`; USAGE (64) is for invocation errors).
mod exit {
    pub const MALFORMED_FILE: u8 = 6;
    pub const USAGE: u8 = 64;
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match &cli.cmd {
        Cmd::Run(args) => run(args),
        Cmd::Validate { file } => validate(file),
        Cmd::Timing {
            file,
            paths,
            cycles,
            sta,
            json,
        } => timing(file, *paths, *cycles, *sta, json.as_deref()),
        Cmd::Snapshot {
            file,
            out,
            cycles,
            clock_half_period_ns,
        } => snapshot(file, out, *cycles, *clock_half_period_ns),
        Cmd::Resume {
            snapshot,
            cycles,
            json,
        } => resume(snapshot, *cycles, json.as_deref()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// The clap command tree must be internally consistent (catches
    /// attribute mistakes at test time instead of at runtime).
    #[test]
    fn cli_definition_is_valid() {
        Cli::command().debug_assert();
    }

    const SETTINGS: &str = r#""settings":{"clockHz":1,"delayTable":"cs2200-74ls-v1"}"#;

    /// The B9 counter fixture as a file, plus a program image.
    /// `tag` makes the dir unique per test (they run in parallel).
    fn counter_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("csim-cli-test-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("counter.csx"),
            format!(
                r##"{{
                "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
                "circuits": [{{ "name": "main", "components": [
                    {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                    {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                    {{"id":"zw","type":"wiring.constant","pos":[0,0]}},
                    {{"id":"za","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":4}}}},
                    {{"id":"zd","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":32}}}},
                    {{"id":"r1","type":"mem.register","pos":[0,0],"name":"r1"}},
                    {{"id":"n1","type":"gate.not","pos":[0,0]}},
                    {{"id":"a1","type":"gate.and","pos":[0,0]}},
                    {{"id":"r2","type":"mem.register","pos":[0,0],"name":"r2"}},
                    {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"out"}},
                    {{"id":"imem","type":"mem.rom","pos":[0,0],"name":"imem",
                      "attrs":{{"bitsize":32,"depth":16,"autoload":"program.hex"}}}}
                ], "wires": [
                    {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r1","pin":"clk"}}}},
                    {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r2","pin":"clk"}}}},
                    {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r1","pin":"en"}}}},
                    {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r2","pin":"en"}}}},
                    {{"a":{{"comp":"zw","pin":"out"}},"b":{{"comp":"r1","pin":"rst"}}}},
                    {{"a":{{"comp":"zw","pin":"out"}},"b":{{"comp":"r2","pin":"rst"}}}},
                    {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"a1","pin":"in1"}}}},
                    {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"n1","pin":"in"}}}},
                    {{"a":{{"comp":"n1","pin":"out"}},"b":{{"comp":"r1","pin":"d"}}}},
                    {{"a":{{"comp":"n1","pin":"out"}},"b":{{"comp":"a1","pin":"in0"}}}},
                    {{"a":{{"comp":"a1","pin":"out"}},"b":{{"comp":"r2","pin":"d"}}}},
                    {{"a":{{"comp":"a1","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}},
                    {{"a":{{"comp":"za","pin":"out"}},"b":{{"comp":"imem","pin":"addr"}}}}
                ]}}]
            }}"##
            ),
        )
        .unwrap();
        std::fs::write(dir.join("program.hex"), "2a 55 14-0\n").unwrap();
        dir
    }

    fn run_args(file: &Path, extra: &[&str]) -> RunArgs {
        let cli = Cli::try_parse_from(
            std::iter::once("csim".to_string())
                .chain(std::iter::once("run".to_string()))
                .chain(std::iter::once(file.display().to_string()))
                .chain(extra.iter().map(|s| s.to_string())),
        )
        .unwrap();
        match cli.cmd {
            Cmd::Run(a) => a,
            _ => panic!("expected run"),
        }
    }

    /// End-to-end (M1 shape): grade a circuit running a provided program
    /// hex; the report has correct cycles/T_obs/est_time/assertions.
    #[test]
    fn run_end_to_end_with_program_hex() {
        let dir = counter_dir("e2e");
        let report_path = dir.join("report.json");
        let args = run_args(
            &dir.join("counter.csx"),
            &[
                "--cycles",
                "3",
                "--assert",
                "probe('r1') == 1",
                "--assert",
                "probe('r2') == 1",
                "--assert",
                "mem('imem')[0] == 0x2A",
                "--assert",
                "mem('imem')[1] == 0x55",
                "--assert",
                "violations == 0",
                "--baseline-est-time",
                "234",
                "--sta",
                "--json",
                report_path.to_str().unwrap(),
            ],
        );
        assert_eq!(run(&args), ExitCode::SUCCESS);
        let report: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&report_path).unwrap()).unwrap();
        assert_eq!(report["cycles"], 3);
        assert_eq!(report["t_obs"], 39);
        assert_eq!(report["est_time"], 117);
        assert_eq!(report["speedup_vs_baseline"], 2.0);
        assert_eq!(report["halt_reason"], "completed");
        assert!(report["assertions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["passed"] == true));
        assert_eq!(report["t_sta"], 34);
        assert!(report["trace_hash"].is_u64());
        // A failing assertion → exit 1.
        let args = run_args(
            &dir.join("counter.csx"),
            &["--cycles", "3", "--assert", "probe('r1') == 0"],
        );
        assert_eq!(run(&args), ExitCode::from(1));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn run_with_spec_file() {
        let dir = counter_dir("spec");
        std::fs::write(
            dir.join("spec.json"),
            r#"{"cycles": 3, "assertions": ["probe('r2') == 1", "mem('imem')[1] == 0x55"]}"#,
        )
        .unwrap();
        let args = run_args(
            &dir.join("counter.csx"),
            &["--spec", dir.join("spec.json").to_str().unwrap()],
        );
        assert_eq!(run(&args), ExitCode::SUCCESS);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn run_sandbox_blocks_outside_autoload() {
        let dir = counter_dir("sandbox");
        std::fs::write(
            dir.join("evil.csx"),
            format!(
                r##"{{
                "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
                "circuits": [{{ "name": "main", "components": [
                    {{"id":"za","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":2}}}},
                    {{"id":"m","type":"mem.rom","pos":[0,0],"name":"m",
                      "attrs":{{"bitsize":32,"depth":4,"autoload":"../outside.hex"}}}}
                ], "wires": [
                    {{"a":{{"comp":"za","pin":"out"}},"b":{{"comp":"m","pin":"addr"}}}}
                ]}}]
            }}"##
            ),
        )
        .unwrap();
        std::fs::write(dir.join("..").join("outside.hex"), "0\n").unwrap();
        let args = run_args(&dir.join("evil.csx"), &["--cycles", "1"]);
        assert_eq!(run(&args), ExitCode::from(exit::USAGE));
        let args = run_args(
            &dir.join("evil.csx"),
            &["--cycles", "1", "--allow-outside-autoload"],
        );
        assert_eq!(run(&args), ExitCode::SUCCESS);
        std::fs::remove_file(dir.join("..").join("outside.hex")).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn timing_subcommand_dta_primary_sta_on_request() {
        let dir = counter_dir("timing");
        let out = dir.join("timing.json");
        // F9: DTA is primary (default cycles when None → 1000); STA only
        // behind --sta.
        assert_eq!(
            timing(&dir.join("counter.csx"), 5, Some(3), true, Some(&out)),
            ExitCode::SUCCESS
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(v["dta"]["cycles"], 3);
        assert_eq!(v["dta"]["t_obs"], 39);
        // F13: STA totals include the destination register's setup time:
        // not 9 + and 10 + setup 15 = 34.
        assert_eq!(v["t_sta"], 34);
        assert!(v["sta_note"].as_str().unwrap().contains("structural bound"));
        // No --sta: STA fields absent, DTA present with the default run.
        assert_eq!(
            timing(&dir.join("counter.csx"), 5, None, false, Some(&out)),
            ExitCode::SUCCESS
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert!(v.get("t_sta").is_none());
        assert_eq!(v["dta"]["cycles"], 1000, "default DTA run length");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F8: `csim validate` catches netlist-level load errors (bitsize
    /// mismatch), exit 6 with the LoadResult JSON shape.
    #[test]
    fn validate_catches_bitsize_mismatch() {
        let dir = std::env::temp_dir().join(format!("csim-cli-val8-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("bad.csx");
        std::fs::write(
            &f,
            r##"{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t",
            "settings": {"clockHz":1,"delayTable":"cs2200-74ls-v1"},
            "circuits": [{ "name": "main", "components": [
                {"id":"a","type":"wiring.pin","pos":[0,0],"name":"a"},
                {"id":"b","type":"wiring.pin","pos":[0,0],"name":"b","attrs":{"bitsize":32}}
            ], "wires": [
                {"a":{"comp":"a","pin":"pin"},"b":{"comp":"b","pin":"pin"}}
            ]}]
        }"##,
        )
        .unwrap();
        assert_eq!(validate(&f), ExitCode::from(exit::MALFORMED_FILE));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F10: `csim run` on a malformed file emits the full §8.2 Report
    /// shape (halt_reason "malformed-file", errors list), exit 6.
    #[test]
    fn run_malformed_emits_report_shape() {
        let dir = std::env::temp_dir().join(format!("csim-cli-f10-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("bad.csx");
        std::fs::write(&f, r#"{"version":2}"#).unwrap();
        let report_path = dir.join("report.json");
        let args = run_args(
            &f,
            &["--cycles", "1", "--json", report_path.to_str().unwrap()],
        );
        assert_eq!(run(&args), ExitCode::from(exit::MALFORMED_FILE));
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&report_path).unwrap()).unwrap();
        assert_eq!(v["halt_reason"], "malformed-file");
        assert!(v["errors"].as_array().unwrap().len() == 1);
        assert_eq!(v["cycles"], 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F2: `csim resume` fully validates the embedded circuit — a
    /// hand-corrupted snapshot (bogus delayTable) is a clean error exit,
    /// never a panic (§11).
    #[test]
    fn resume_rejects_invalid_embedded_circuit() {
        let dir = counter_dir("resume-evil");
        let snap = dir.join("state.json");
        assert_eq!(
            snapshot(&dir.join("counter.csx"), &snap, 1, None),
            ExitCode::SUCCESS
        );
        // Corrupt the embedded circuit's delayTable.
        let mut v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&snap).unwrap()).unwrap();
        v["circuit"]["settings"]["delayTable"] = serde_json::json!("bogus-table");
        std::fs::write(&snap, serde_json::to_string(&v).unwrap()).unwrap();
        assert_eq!(resume(&snap, 1, None), ExitCode::from(exit::MALFORMED_FILE));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn snapshot_resume_roundtrip() {
        let dir = counter_dir("snap");
        let snap = dir.join("state.json");
        assert_eq!(
            snapshot(&dir.join("counter.csx"), &snap, 3, None),
            ExitCode::SUCCESS
        );
        let out = dir.join("resumed.json");
        assert_eq!(resume(&snap, 3, Some(&out)), ExitCode::SUCCESS);
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(v["cycle"], 6);
        // r1 after 6 toggles = 0 (0→1→0→1→0→1→0).
        let r1 = &v["named"]
            .as_array()
            .unwrap()
            .iter()
            .find(|nv| nv[0] == "r1")
            .unwrap()[1];
        assert_eq!(r1["v"], ""); // empty hex mask = 0 (ipc.md)
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `csim validate`: valid file exits 0, invalid exits MALFORMED_FILE
    /// with the full error list, unreadable file exits MALFORMED_FILE with
    /// an Io error.
    #[test]
    fn validate_subcommand() {
        let dir = std::env::temp_dir();
        let valid = dir.join("csim-test-valid.csx");
        let invalid = dir.join("csim-test-invalid.csx");

        std::fs::write(
            &valid,
            r#"{"format":"circuitsim-plus-plus","version":3,"name":"t",
                "settings":{"clockHz":1,"delayTable":"cs2200-74ls-v1"},
                "circuits":[{"name":"main","components":[
                    {"id":"c0","type":"wiring.clock","pos":[0,0]}
                ]}]}"#,
        )
        .unwrap();
        std::fs::write(&invalid, r#"{"version":2}"#).unwrap();

        assert_eq!(validate(&valid), ExitCode::SUCCESS);
        assert_eq!(validate(&invalid), ExitCode::from(exit::MALFORMED_FILE));
        assert_eq!(
            validate(&dir.join("csim-test-does-not-exist.csx")),
            ExitCode::from(exit::MALFORMED_FILE)
        );

        let _ = std::fs::remove_file(&valid);
        let _ = std::fs::remove_file(&invalid);
    }

    /// The §8.1 invocation shape must parse.
    #[test]
    fn run_invocation_parses() {
        let cli = Cli::try_parse_from([
            "csim",
            "run",
            "submission.csx",
            "--load",
            "imem=program.hex",
            "--load",
            "dmem=data.hex",
            "--cycles",
            "500000",
            "--timeout",
            "60s",
            "--assert",
            "probe('result') == 0x2A",
            "--json",
            "report.json",
        ])
        .unwrap();
        match cli.cmd {
            Cmd::Run(args) => {
                assert_eq!(args.load.len(), 2);
                assert_eq!(args.cycles, Some(500000));
                assert_eq!(args.asserts.len(), 1);
            }
            _ => panic!("expected run subcommand"),
        }
    }

    #[test]
    fn duration_parsing() {
        assert_eq!(parse_duration("60s"), Ok(Duration::from_secs(60)));
        assert_eq!(parse_duration("500ms"), Ok(Duration::from_millis(500)));
        assert_eq!(parse_duration("2m"), Ok(Duration::from_secs(120)));
        assert_eq!(parse_duration("45"), Ok(Duration::from_secs(45)));
        assert!(parse_duration("soon").is_err());
    }
}
