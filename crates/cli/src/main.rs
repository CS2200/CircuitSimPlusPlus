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

use csim_core::api::{LoadError, LoadErrorKind, SimMode};
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
    /// Timing analysis: informational STA (always) plus a DTA run when
    /// --cycles is given (DESIGN.md §4.4).
    Timing {
        /// Circuit file (.csx).
        file: PathBuf,
        /// Number of top critical paths to report.
        #[arg(long, default_value_t = 10)]
        paths: usize,
        /// Also run this many cycles for observed (DTA) timing.
        #[arg(long)]
        cycles: Option<u64>,
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
        /// Simulation mode (default delay).
        #[arg(long, value_parser = ["delay", "zero"])]
        mode: Option<String>,
        /// Clock half-period in ns (delay mode).
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
    /// Simulation mode: delay (default, grading) or zero (DESIGN.md §4.2–4.4).
    #[arg(long, value_parser = ["delay", "zero"])]
    mode: Option<String>,
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

/// `csim validate <file>`: parse + validate, print the complete error list
/// as JSON. Exit 0 when valid, `MALFORMED_FILE` otherwise.
fn validate(file: &Path) -> ExitCode {
    let errors = match std::fs::read(file) {
        Ok(bytes) => match format::load_document(&bytes) {
            Ok(_) => Vec::new(),
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

/// Collect `autoload` attrs (named memories) from the document; explicit
/// --load entries win. Paths resolve against the circuit file's dir (§11).
fn autoloads(
    doc: &Document,
    circuit_dir: &Path,
    explicit: &[String],
    relaxed: bool,
) -> Result<Vec<(String, LoadSource)>, String> {
    let mut out = Vec::new();
    for circuit in &doc.circuits {
        for comp in &circuit.components {
            let name = &comp.name;
            if name.is_empty() {
                continue;
            }
            let Some(target) = comp.attrs.get("autoload") else {
                continue;
            };
            if !matches!(comp.type_.as_str(), "mem.ram" | "mem.rom") {
                continue;
            }
            let Some(rel) = target.as_str() else {
                return Err(format!("{name}: 'autoload' must be a string"));
            };
            if explicit
                .iter()
                .any(|l| l.split_once('=').is_some_and(|(n, _)| n == name))
            {
                continue; // explicit --load wins
            }
            let path = sandbox_check(circuit_dir, Path::new(rel), relaxed)?;
            out.push((name.clone(), LoadSource::File(path)));
        }
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
    if let Some(m) = &args.mode {
        cfg.mode = match m.as_str() {
            "zero" => SimMode::Zero,
            _ => SimMode::Delay,
        };
    }
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
    let bytes = match std::fs::read(&args.file) {
        Ok(b) => b,
        Err(e) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "ok": false, "errors": io_error(&args.file, &e)
                }))
                .expect("serializes")
            );
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let doc = match format::load_document(&bytes) {
        Ok(d) => d,
        Err(errors) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "ok": false, "errors": errors
                }))
                .expect("serializes")
            );
            return ExitCode::from(exit::MALFORMED_FILE);
        }
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

/// `csim timing`: STA always; DTA when --cycles is given (§4.4).
fn timing(file: &Path, paths: usize, cycles: Option<u64>, json_out: Option<&Path>) -> ExitCode {
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
    let nl = match csim_core::netlist::build(&doc) {
        Ok(nl) => nl,
        Err(errors) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "ok": false, "errors": errors
                }))
                .expect("serializes")
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
    let (t_sta, sta_note, sta_paths) = match csim_core::sta::analyze(&nl, &table, paths) {
        Ok(r) => (
            Some(r.t_sta),
            "structural bound — may include paths your design never uses".to_string(),
            r.top_paths
                .iter()
                .map(|p| {
                    serde_json::json!({
                        "delay": p.delay,
                        "endpoint": nl.comps[p.endpoint.idx()].name,
                        "comps": p.comps.iter().map(|c| nl.comps[c.idx()].name.clone()
                            .unwrap_or_else(|| format!("{}:{}", nl.comps[c.idx()].def_circuit, nl.comps[c.idx()].def_id))).collect::<Vec<_>>(),
                    })
                })
                .collect::<Vec<_>>(),
        ),
        Err(e) => (None, e.to_string(), Vec::new()),
    };
    let mut out = serde_json::json!({
        "t_sta": t_sta,
        "sta_note": sta_note,
        "sta_paths": sta_paths,
        "delay_table": format!("{} ({})", table.name(), table.status()),
    });
    if let Some(n) = cycles {
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
    let json = serde_json::to_string_pretty(&out).expect("serializes");
    print_or_write(&json, json_out)
}

/// Self-contained snapshot file: circuit + mode + engine state.
fn snapshot(
    file: &Path,
    out: &Path,
    cycles: u64,
    mode: Option<&str>,
    half: Option<u64>,
) -> ExitCode {
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
    let zero = matches!(mode, Some("zero"));
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
    let doc_json = serde_json::to_value(&doc).expect("document serializes");
    let (state_json, run_cycles) = if zero {
        let mut eng = match csim_core::zero::ZeroEngine::new(nl) {
            Ok(e) => e,
            Err(errors) => {
                eprintln!(
                    "csim: {}",
                    serde_json::to_string(&errors).expect("serializes")
                );
                return ExitCode::from(exit::MALFORMED_FILE);
            }
        };
        if let Err(h) = eng.run(cycles) {
            eprintln!("csim: halted: {h}");
            return ExitCode::from(autograde::EXIT_ASSERTION_FAILED as u8);
        }
        (eng.snapshot(), eng.cycle())
    } else {
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
        match eng.run(cycles) {
            Ok(rep) => (eng.snapshot(), rep.cycles),
            Err(h) => {
                eprintln!("csim: halted: {h}");
                return ExitCode::from(autograde::EXIT_ASSERTION_FAILED as u8);
            }
        }
    };
    let file_json = serde_json::json!({
        "format": "csim-snapshot",
        "version": 1,
        "mode": if zero { "zero" } else { "delay" },
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
    if file["format"] != "csim-snapshot" || file["version"] != 1 {
        eprintln!("csim: not a csim-snapshot v1 file");
        return ExitCode::from(exit::MALFORMED_FILE);
    }
    let doc: Document = match serde_json::from_value(file["circuit"].clone()) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("csim: bad embedded circuit: {e}");
            return ExitCode::from(exit::MALFORMED_FILE);
        }
    };
    let state = serde_json::to_string(&file["state"]).expect("state serializes");
    let zero = file["mode"] == "zero";
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
    let out = if zero {
        let mut eng = csim_core::zero::ZeroEngine::new(nl).expect("netlist rebuilt");
        if let Err(e) = eng.restore(&state) {
            eprintln!("csim: {e}");
            return ExitCode::from(exit::MALFORMED_FILE);
        }
        if let Err(h) = eng.run(cycles) {
            eprintln!("csim: halted: {h}");
            return ExitCode::from(autograde::EXIT_ASSERTION_FAILED as u8);
        }
        let vals = named_values(eng.netlist(), &|n| eng.named_value(n));
        serde_json::json!({ "cycle": eng.cycle(), "halted": false, "named": vals })
    } else {
        let table = TimingTable::builtin(&doc.settings.delay_table).expect("validated at load");
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
            json,
        } => timing(file, *paths, *cycles, json.as_deref()),
        Cmd::Snapshot {
            file,
            out,
            cycles,
            mode,
            clock_half_period_ns,
        } => snapshot(file, out, *cycles, mode.as_deref(), *clock_half_period_ns),
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

    const SETTINGS: &str =
        r#""settings":{"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"}"#;

    /// The B9 counter fixture as a file, plus a program image.
    /// `tag` makes the dir unique per test (they run in parallel).
    fn counter_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("csim-cli-test-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("counter.csx"),
            format!(
                r##"{{
                "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
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
        assert_eq!(report["t_sta"], 19);
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
    fn run_mode_zero_and_spec_file() {
        let dir = counter_dir("spec");
        std::fs::write(
            dir.join("spec.json"),
            r#"{"cycles": 3, "assertions": ["probe('r2') == 1", "mem('imem')[1] == 0x55"]}"#,
        )
        .unwrap();
        let args = run_args(
            &dir.join("counter.csx"),
            &[
                "--mode",
                "zero",
                "--spec",
                dir.join("spec.json").to_str().unwrap(),
            ],
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
                "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
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
    fn timing_subcommand_sta_and_dta() {
        let dir = counter_dir("timing");
        let out = dir.join("timing.json");
        assert_eq!(
            timing(&dir.join("counter.csx"), 5, Some(3), Some(&out)),
            ExitCode::SUCCESS
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(v["t_sta"], 19);
        assert!(v["sta_note"].as_str().unwrap().contains("structural bound"));
        assert_eq!(v["dta"]["cycles"], 3);
        assert_eq!(v["dta"]["t_obs"], 39);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn snapshot_resume_roundtrip_delay_and_zero() {
        let dir = counter_dir("snap");
        for mode in ["delay", "zero"] {
            let snap = dir.join(format!("state-{mode}.json"));
            assert_eq!(
                snapshot(&dir.join("counter.csx"), &snap, 3, Some(mode), None),
                ExitCode::SUCCESS
            );
            let out = dir.join(format!("resumed-{mode}.json"));
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
            assert_eq!(r1["v"], "", "{mode}"); // empty hex mask = 0 (ipc.md)
        }
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
            r#"{"format":"circuitsim-plus-plus","version":2,"name":"t",
                "settings":{"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"},
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
                assert_eq!(args.mode, None); // defaults to delay downstream
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
