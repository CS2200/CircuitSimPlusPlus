//! `csim` — headless CLI / Gradescope autograder runner (DESIGN.md §8).
//!
//! Pure Rust, statically linkable (`x86_64-unknown-linux-musl`), no webview.
//! Command surface is pinned here (BACKEND.md task B10 fills in behavior).

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};

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
    /// Print timing analysis (DTA observed paths / informational STA).
    Timing {
        /// Circuit file (.csx).
        file: PathBuf,
        /// Number of top critical paths to report.
        #[arg(long, default_value_t = 10)]
        paths: usize,
    },
    /// Save a full engine snapshot after a run.
    Snapshot {
        /// Circuit file (.csx).
        file: PathBuf,
        /// Output snapshot path.
        #[arg(long)]
        out: PathBuf,
        /// Run this many cycles before snapshotting.
        #[arg(long, default_value_t = 0)]
        cycles: u64,
    },
    /// Resume from a snapshot and continue running.
    Resume {
        /// Snapshot file.
        snapshot: PathBuf,
        /// Run this many cycles after resuming.
        #[arg(long, default_value_t = 0)]
        cycles: u64,
    },
}

#[derive(Args)]
struct RunArgs {
    /// Circuit file (.csx).
    file: PathBuf,
    /// Preload a named memory: --load name=file.hex (repeatable; §8.1).
    #[arg(long)]
    load: Vec<String>,
    /// Cycle limit.
    #[arg(long)]
    cycles: Option<u64>,
    /// Wall-clock timeout, e.g. 60s.
    #[arg(long)]
    timeout: Option<String>,
    /// Simulation mode: delay (default, grading) or zero (DESIGN.md §4.2–4.4).
    #[arg(long, value_parser = ["delay", "zero"])]
    mode: Option<String>,
    /// Assertion, e.g. --assert "probe('result') == 0x2A" (repeatable; §8.2).
    #[arg(long = "assert")]
    asserts: Vec<String>,
    /// Write the JSON report to this path (§8.2).
    #[arg(long)]
    json: Option<PathBuf>,
}

/// Exit codes (DESIGN.md §8.2 — distinct non-zero per failure class).
/// 0 = success / all assertions passed. Only `MALFORMED_FILE` is used
/// until B10 wires up `run`.
#[allow(dead_code)]
mod exit {
    pub const ASSERTION_FAILED: u8 = 1;
    pub const CYCLE_LIMIT: u8 = 2;
    pub const TIMEOUT: u8 = 3;
    pub const OSCILLATION: u8 = 4;
    pub const FLOATING_READ: u8 = 5;
    pub const MALFORMED_FILE: u8 = 6;
}

/// `csim validate <file>`: parse + validate, print the complete error list
/// as JSON. Exit 0 when valid, `MALFORMED_FILE` otherwise.
fn validate(file: &std::path::Path) -> ExitCode {
    let errors = match std::fs::read(file) {
        Ok(bytes) => match csim_core::format::load_document(&bytes) {
            Ok(_) => Vec::new(),
            Err(errors) => errors,
        },
        Err(e) => vec![csim_core::api::LoadError {
            kind: csim_core::api::LoadErrorKind::Io,
            message: format!("{}: {e}", file.display()),
            circuit: String::new(),
            comp_id: None,
            wire_idx: None,
        }],
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

fn main() -> ExitCode {
    let cli = Cli::parse();
    // BACKEND.md tasks B9/B10 implement these against csim_core::api::Sim.
    match &cli.cmd {
        Cmd::Run(_) => unimplemented!("csim run — BACKEND.md task B10"),
        Cmd::Validate { file } => validate(file),
        Cmd::Timing { .. } => unimplemented!("csim timing — BACKEND.md tasks B6/B8"),
        Cmd::Snapshot { .. } => unimplemented!("csim snapshot — BACKEND.md task B5"),
        Cmd::Resume { .. } => unimplemented!("csim resume — BACKEND.md task B5"),
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
}
