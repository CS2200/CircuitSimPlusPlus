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

fn main() -> ExitCode {
    let cli = Cli::parse();
    // BACKEND.md tasks B9/B10 implement these against csim_core::api::Sim.
    match &cli.cmd {
        Cmd::Run(_) => unimplemented!("csim run — BACKEND.md task B10"),
        Cmd::Validate { .. } => unimplemented!("csim validate — BACKEND.md task B2"),
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
